import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import Memory from '../models/Memory.js';
import env from '../config/env.js';
import { AppError } from '../middleware/errorHandler.js';
import { success, created } from '../utils/response.js';
import { processMessage, isSafeAiErrorMessage } from '../services/aiService.js';
import { extractTextFromBuffer } from '../services/documentText.js';
import * as storageService from '../services/storageService.js';
import { detectAction, buildUnsupportedMessage } from '../services/actionDetector.js';
import { isDeveloperQuery } from '../services/developerInfo.js';
import { isCodingRequest } from '../services/intentDetector.js';
import * as webSearchService from '../services/webSearchService.js';
import { planSearch } from '../services/searchPlanner.js';
import { isConversationalMessage } from '../services/conversationIntent.js';

const MAX_DOC_CONTEXT = 24000;
const CHAT_PAGE_DEFAULT_LIMIT = 50;
const CHAT_PAGE_MAX_LIMIT = 100;

const CHAT_MODES = ['chat', 'coding', 'voice', 'documents', 'translate'];

// Universal web-search stage. EVERY non-empty user question goes through the
// live web first: there is deliberately NO topic/keyword classifier, no
// whitelist and no "should we search?" decision based on the question's
// content. The same code path handles a question the developer has never
// seen. The ONE exception is a purely social/ritual message (a greeting,
// thanks, a farewell, an emoji ping): it carries nothing to look up, so
// services/conversationIntent.js lets it skip the stage instead of running a
// meaningless query that would drag in sources, citations and a resource
// card. Every message containing a content word still takes the universal
// search path below.
//
// The reusable planning (conversation-aware query -> search -> relevance
// check -> optional refined search) lives in services/searchPlanner.js;
// this function only maps its outcome onto the three stage types:
//
//   - "none"   -> nothing searchable (e.g. an attachment-only message or a
//                 purely social message)
//   - "static" -> search is disabled or failed (an honest fallback message,
//                 never a silent answer from stale internal knowledge), or the
//                 intent is genuinely ambiguous and needs a short clarification
//   - "search" -> results (or an explicit "no results" note) + sources for AI
//
// `history` is the conversation so far (including the triggering message),
// so a short follow-up is searched with its subject resolved from context.
//
// Exported for local verification scripts (no request/response involved).
export const runWebSearchStage = async (content, history = [], planner = planSearch) => {
  // Social/ritual messages never reach the planner: no query is built from
  // them, so a "hi" can never produce sources, citations or a video card.
  if (isConversationalMessage(content)) return { type: 'none', conversational: true };

  let plan;
  try {
    plan = await planner({ content, history });
  } catch (err) {
    console.error('[WebSearch] Failed:', err?.message || err);
    return {
      type: 'static',
      content: webSearchService.SEARCH_UNAVAILABLE_MESSAGE,
      metadata: { webSearch: { used: true, query: '', sources: [], error: true } },
    };
  }

  if (plan.status === 'no_query') return { type: 'none' };

  // The resolver judged the message purely conversational (small talk the
  // deterministic fast path did not catch, in any language / with typos).
  // Like a greeting, it skips the web stage entirely - no query, sources,
  // citations or resource card - and gets a brief conversational reply.
  if (plan.status === 'chat') return { type: 'none', conversational: true };

  // The intent resolver decided the message has genuinely ambiguous meanings.
  // Ask the short clarification instead of guessing (and never search the
  // literal misspelling). The user's original message stays in the history.
  if (plan.status === 'clarify') {
    return {
      type: 'static',
      content: plan.clarification,
      metadata: {},
    };
  }

  if (plan.status === 'disabled') {
    console.error('[WebSearch] WEB_SEARCH_ENABLED is not true — live web search is required but not configured.');
    return {
      type: 'static',
      content: webSearchService.SEARCH_DISABLED_MESSAGE,
      metadata: { webSearch: { used: false, query: plan.query, sources: [] } },
    };
  }

  if (plan.status === 'failed') {
    console.error('[WebSearch] Failed:', plan.error?.message || plan.error);
    return {
      type: 'static',
      content: webSearchService.SEARCH_UNAVAILABLE_MESSAGE,
      metadata: { webSearch: { used: true, query: plan.query, sources: [], error: true } },
    };
  }

  const sources = Array.isArray(plan.sources) ? plan.sources : [];
  const images = Array.isArray(plan.images) ? plan.images : [];
  return {
    type: 'search',
    sources,
    images,
    // Zero relevant results are NOT a failure: the AI is told the search came
    // back empty so it can say so honestly instead of inventing an answer.
    contextText: sources.length > 0
      ? webSearchService.buildSearchContext(sources, images)
      : webSearchService.NO_RESULTS_CONTEXT,
    metadata: {
      webSearch: {
        used: true,
        query: plan.query,
        sources,
        ...(images.length > 0 ? { images } : {}),
        ...(plan.refined ? { refined: true } : {}),
      },
    },
  };
};

const buildDocuments = (messages) => {
  const docs = [];
  for (const m of messages) {
    if (m.role !== 'user' || !m.attachments || !m.attachments.length) continue;
    for (const att of m.attachments) {
      if (att.type === 'document' && att.text) {
        docs.push({ filename: att.filename || 'document', text: att.text });
      }
    }
  }
  const trimmed = [];
  let chars = 0;
  for (const d of docs) {
    if (chars >= MAX_DOC_CONTEXT) break;
    const remaining = MAX_DOC_CONTEXT - chars;
    trimmed.push({ filename: d.filename, text: d.text.slice(0, remaining) });
    chars += Math.min(d.text.length, remaining);
  }
  return trimmed;
};

// Attach a fresh short-lived signed URL to every stored attachment so the
// frontend preview/lightbox/click-to-open keeps working while the bucket stays
// private. Called right before any message payload leaves the server.
const withSignedUrls = async (payload) => {
  if (!payload) return payload;
  if (Array.isArray(payload)) return Promise.all(payload.map(withSignedUrls));
  if (typeof payload !== 'object') return payload;
  if (Array.isArray(payload.attachments)) {
    payload.attachments = await storageService.withSignedUrls(payload.attachments);
  }
  if (Array.isArray(payload.messages)) {
    for (const msg of payload.messages) {
      if (msg && Array.isArray(msg.attachments)) {
        msg.attachments = await storageService.withSignedUrls(msg.attachments);
      }
    }
  }
  if (payload.userMessage && Array.isArray(payload.userMessage.attachments)) {
    payload.userMessage.attachments = await storageService.withSignedUrls(payload.userMessage.attachments);
  }
  return payload;
};

const hydrateDocText = async (attachments) => {
  for (const att of (attachments || []).filter(Boolean)) {
    if (att.type !== 'document' || !att.path || att.text) continue;
    try {
      // Text extraction needs the raw bytes: pull them from Supabase Storage
      // for new objects, fall back to disk only for legacy `uploads/...` rows.
      let buffer;
      if (String(att.path).startsWith('user-')) {
        buffer = await storageService.downloadBuffer(att.path);
      } else {
        const path = await import('path');
        const fs = await import('fs');
        buffer = fs.readFileSync(path.resolve(process.cwd(), att.path));
      }
      const text = await extractTextFromBuffer(buffer, att.filename);
      att.text = text.slice(0, 60000);
    } catch {
      att.text = '';
    }
  }
  return attachments || [];
};

const setTitleIfDefault = (chat, content, attachments = []) => {
  if (!chat || (chat.title && chat.title !== 'New Chat')) return chat.title;
  const stripped = String(content || '').trim().replace(/\s+/g, ' ');
  if (!stripped) {
    const hasImage = (attachments || []).some(a => a && (a.type === 'image' || (a.mimetype && a.mimetype.startsWith('image/'))));
    if (hasImage) chat.title = 'Image analysis';
    else if ((attachments || []).length > 0) chat.title = 'File analysis';
    return chat.title;
  }
  chat.title = stripped.slice(0, 80) + (stripped.length > 80 ? '...' : '');
  return chat.title;
};

// Normalize client-provided message attachments so a message can never be
// persisted with an attachment that lacks its stored file metadata (`path`).
// Anything that does not resolve to a real uploaded file (missing path, path
// traversal, non-object entry) rejects the request instead of silently
// dropping the image/file from the message.
const sanitizeMessageAttachments = (attachments) => {
  if (!Array.isArray(attachments) || attachments.length === 0) return [];
  const out = [];
  for (const att of attachments) {
    if (!att || typeof att !== 'object') {
      throw new AppError('Invalid attachment in message', 400);
    }
    const rawPath = String(att.path || '').trim();
    if (!rawPath) {
      throw new AppError('Attachment is missing its stored file path', 400);
    }
    if (rawPath.split(/[\\/]/).includes('..')) {
      throw new AppError('Invalid attachment path', 400);
    }
    const mimetype = att.mimetype || '';
    const type = att.type === 'image' || att.type === 'document'
      ? att.type
      : (mimetype.startsWith('image/') ? 'image' : 'document');
    out.push({
      id: att.id || null,
      filename: att.filename || 'attachment',
      path: rawPath,
      mimetype,
      type,
      size: Number.isFinite(Number(att.size)) ? Number(att.size) : undefined,
    });
  }
  return out;
};

export const getChats = async (req, res, next) => {
  try {
    if (!req.user) return success(res, []);
    const { search, archived, pinned, page, limit } = req.query;
    const query = { user: req.user._id };

    if (archived === 'true') query.archived = true;
    else query.archived = false;

    if (pinned === 'true') query.pinned = true;
    if (search) query.title = { $regex: search, $options: 'i' };

    const paginated = page !== undefined || limit !== undefined;
    if (paginated) {
      const pageNum = Math.max(1, Number.parseInt(page, 10) || 1);
      const limitNum = Math.min(CHAT_PAGE_MAX_LIMIT, Math.max(1, Number.parseInt(limit, 10) || CHAT_PAGE_DEFAULT_LIMIT));
      const from = (pageNum - 1) * limitNum;
      const [total, chats] = await Promise.all([
        Conversation.count(query),
        Conversation.find(query)
          .sort({ pinned: -1, updatedAt: -1 })
          .range(from, from + limitNum - 1)
          .select('-__v'),
      ]);
      return success(res, {
        chats,
        page: pageNum,
        limit: limitNum,
        total,
        hasMore: pageNum * limitNum < total,
      });
    }

    const chats = await Conversation.find(query)
      .sort({ pinned: -1, updatedAt: -1 })
      .limit(100)
      .select('-__v');

    success(res, chats);
  } catch (err) {
    next(err);
  }
};

export const createChat = async (req, res, next) => {
  try {
    if (!req.user) throw new AppError('Authentication required', 401);
    const { title, mode } = req.body;
    const chat = await Conversation.create({
      user: req.user._id,
      title: title || 'New Chat',
      mode: mode || 'chat',
    });
    created(res, chat);
  } catch (err) {
    next(err);
  }
};

export const getChat = async (req, res, next) => {
  try {
    if (!req.user) throw new AppError('Authentication required', 401);
    const chat = await Conversation.findOne({ _id: req.params.id, user: req.user._id });
    if (!chat) throw new AppError('Chat not found', 404);
    const messages = await Message.find({ conversation: chat._id }).sort({ createdAt: 1 });
    // Re-issue signed URLs on every read so previews survive page refresh,
    // re-login and Render redeploys (signed URLs are short-lived by design).
    await withSignedUrls(messages);
    success(res, { chat, messages });
  } catch (err) {
    next(err);
  }
};

// Re-sign the attachments a client is currently displaying.
//
// Signed URLs are short-lived BY DESIGN, so a conversation left open in a tab
// will outlive the URLs that were handed to it at load time. Rather than
// letting the client hold a dead URL until the next full chat fetch, it asks
// for exactly the keys it needs and gets freshly minted ones back.
//
// Authorisation is deliberately narrow:
//   * the conversation must belong to the caller (same check as getChat), and
//   * every requested key must actually be referenced by one of THAT
//     conversation's messages, so this cannot be used to mint URLs for
//     arbitrary objects in the bucket.
// Legacy `uploads/...` rows are rejected by storageService.signPaths: there is
// nothing in the bucket to sign, and the client must never request /uploads.
export const refreshAttachmentUrls = async (req, res, next) => {
  try {
    if (!req.user) throw new AppError('Authentication required', 401);
    const chat = await Conversation.findOne({ _id: req.params.id, user: req.user._id });
    if (!chat) throw new AppError('Chat not found', 404);

    const requested = Array.isArray(req.body?.paths) ? req.body.paths : [];
    if (requested.length === 0) return success(res, { urls: {} });

    const messages = await Message.find({ conversation: chat._id }).select('attachments');
    const owned = new Set();
    for (const msg of messages) {
      for (const att of (Array.isArray(msg.attachments) ? msg.attachments : [])) {
        const p = String(att?.path || '').trim();
        if (p) owned.add(p);
      }
    }

    const paths = requested
      .map((p) => String(p || '').trim())
      .filter((p) => p && owned.has(p));

    const urls = await storageService.signPaths(paths);
    success(res, { urls, expiresIn: env.supabaseStorageSignedUrlTtl });
  } catch (err) {
    next(err);
  }
};

export const updateChat = async (req, res, next) => {
  try {
    if (!req.user) throw new AppError('Authentication required', 401);
    const { title, pinned, archived, mode } = req.body;
    const updates = {};
    if (title !== undefined) updates.title = title;
    if (pinned !== undefined) updates.pinned = pinned;
    if (archived !== undefined) updates.archived = archived;
    if (mode !== undefined) updates.mode = mode;

    const chat = await Conversation.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      updates,
      { new: true }
    );
    if (!chat) throw new AppError('Chat not found', 404);
    success(res, chat);
  } catch (err) {
    next(err);
  }
};

export const deleteChat = async (req, res, next) => {
  try {
    if (!req.user) throw new AppError('Authentication required', 401);
    const chat = await Conversation.findOneAndDelete({ _id: req.params.id, user: req.user._id });
    if (!chat) throw new AppError('Chat not found', 404);
    await Message.deleteMany({ conversation: chat._id });
    success(res, null, 'Chat deleted');
  } catch (err) {
    next(err);
  }
};

export const uploadChatFile = async (req, res, next) => {
  try {
    if (!req.user) throw new AppError('Authentication required', 401);
    if (!req.file?.buffer) throw new AppError('No file uploaded', 400);

    const { buffer, originalname, mimetype, size } = req.file;
    const type = mimetype.startsWith('image/') ? 'image' : 'document';

    // Persist bytes to the PRIVATE, owner-scoped Supabase Storage bucket and
    // return the storage key + a fresh signed URL. No disk path is ever
    // produced or exposed to the client.
    const uploaded = await storageService.uploadBuffer({
      authUid: req.authUserId || req.user._id?.toString(),
      buffer,
      contentType: mimetype,
      filename: originalname,
    });

    success(res, {
      id: uploaded.path,
      filename: originalname,
      path: uploaded.path,
      url: uploaded.url,
      mimetype,
      type,
      size,
    });
  } catch (err) {
    next(err);
  }
};

const assertOwnProfile = (req) => {
  if (!req.user) throw new AppError('Authentication required', 401);
  if (req.authUserId && req.user._id !== req.authUserId) {
    console.error(`[Chat] identity mismatch: profile._id=${req.user._id} authUserId=${req.authUserId}`);
    throw new AppError('Profile identity mismatch. Please sign in again.', 500);
  }
};

export const sendMessage = async (req, res, next) => {
  try {
    assertOwnProfile(req);
    const { conversationId, content, attachments, mode } = req.body;
    const sanitizedAttachments = sanitizeMessageAttachments(attachments);
    if (!content && sanitizedAttachments.length === 0) {
      throw new AppError('Message content or attachments required', 400);
    }

    let chat;
    if (conversationId) {
      chat = await Conversation.findOne({ _id: conversationId, user: req.user._id });
      if (!chat) throw new AppError('Chat not found', 404);
    } else {
      chat = await Conversation.create({ user: req.user._id, title: 'New Chat' });
    }

    if (mode && CHAT_MODES.includes(mode)) chat.mode = mode;
    if (!chat.mode || chat.mode === 'chat') {
      if (isCodingRequest(content || '')) chat.mode = 'coding';
    }

    const hydratedAttachments = await hydrateDocText(sanitizedAttachments);

    const userMessage = await Message.create({
      conversation: chat._id,
      role: 'user',
      content: content || '',
      attachments: hydratedAttachments,
    });

    const history = await Message.find({ conversation: chat._id })
      .sort({ createdAt: 1 })
      .limit(50)
      .select('role content attachments');

    const documents = buildDocuments(history);

    let memories = [];
    if (req.user.memoryEnabled) {
      memories = await Memory.find({ user: req.user._id }).limit(10).select('content');
    }

    const actionRequest = detectAction(content || '');
    if (actionRequest) {
      if (actionRequest.type === 'unsupported_action') {
        const safeContent = buildUnsupportedMessage(actionRequest.target);
        const assistantMessage = await Message.create({
          conversation: chat._id,
          role: 'assistant',
          content: safeContent,
        });
        await setTitleIfDefault(chat, content, hydratedAttachments);
        chat.updatedAt = new Date();
        await chat.save();
        return success(res, await withSignedUrls({ chat, userMessage, assistantMessage }));
      }

      await setTitleIfDefault(chat, content, hydratedAttachments);
      chat.updatedAt = new Date();
      await chat.save();
      return success(res, await withSignedUrls({ chat, userMessage, action: actionRequest }));
    }

    // Images are interpreted by the vision model from the rendered attachment;
    // broadcasting pixel content into a web search is meaningless and lets the
    // answer grounder rewrite vision output into search disclaimers. Skip the
    // web-search stage entirely when this message carries an image.
    const webStage = hydratedAttachments.some(a => a.type === 'image')
      ? null
      : await runWebSearchStage(content || '', history);

    if (webStage && webStage.type === 'static') {
      const assistantMessage = await Message.create({
        conversation: chat._id,
        role: 'assistant',
        content: webStage.content,
        metadata: webStage.metadata || {},
      });
      await setTitleIfDefault(chat, content, hydratedAttachments);
      chat.updatedAt = new Date();
      await chat.save();
      return success(res, await withSignedUrls({ chat, userMessage, assistantMessage }));
    }

    const aiResponse = await processMessage({
      messages: history.map(m => ({ role: m.role, content: m.content })),
      memories: memories.map(m => m.content),
      mode: chat.mode,
      attachments: hydratedAttachments,
      userContent: content,
      documents,
      webSearch: webStage && webStage.type === 'search'
        ? { sources: webStage.sources, images: webStage.images || [], text: webStage.contextText }
        : null,
      conversational: Boolean(webStage && webStage.conversational),
    });

    const assistantMessage = await Message.create({
      conversation: chat._id,
      role: 'assistant',
      content: aiResponse.content,
      metadata: {
        ...(aiResponse.metadata || {}),
        ...(webStage && webStage.type === 'search' ? webStage.metadata : {}),
        ...(isDeveloperQuery(content || '') ? { developerProfile: true } : {}),
      },
    });

    await setTitleIfDefault(chat, content, hydratedAttachments);
    chat.updatedAt = new Date();
    await chat.save();

    await withSignedUrls(userMessage);
    success(res, {
      chat,
      userMessage,
      assistantMessage,
    });
  } catch (err) {
    console.error('[Chat][sendMessage] Error:', err?.message || err);
    next(err);
  }
};

export const streamMessage = async (req, res, next) => {
  try {
    assertOwnProfile(req);
    const { conversationId, content, attachments, regenerate, editMessageId, mode } = req.body;
    const sanitizedAttachments = sanitizeMessageAttachments(attachments);

    let chat;
    if (conversationId) {
      chat = await Conversation.findOne({ _id: conversationId, user: req.user._id });
      if (!chat) throw new AppError('Chat not found', 404);
    } else {
      chat = await Conversation.create({ user: req.user._id, title: 'New Chat' });
    }

    if (mode && CHAT_MODES.includes(mode)) chat.mode = mode;
    if (!chat.mode || chat.mode === 'chat') {
      if (isCodingRequest(content || '')) chat.mode = 'coding';
    }

    let triggerContent = content || '';
    let triggerAttachments = sanitizedAttachments;

    let isEdit = false;
    let userMessageId = null;
    if (editMessageId) {
      const targetMsg = await Message.findOne({ _id: editMessageId, conversation: chat._id, role: 'user' });
      if (!targetMsg) throw new AppError('Message not found to edit', 404);
      triggerAttachments = await hydrateDocText(triggerAttachments);
      targetMsg.content = triggerContent;
      targetMsg.attachments = triggerAttachments;
      await targetMsg.save();
      await Message.deleteMany({ conversation: chat._id, createdAt: { $gt: targetMsg.createdAt } });
      isEdit = true;
      userMessageId = targetMsg._id;
    }

    if (regenerate || isEdit) {
      const lastUserMsg = await Message.findOne({ conversation: chat._id, role: 'user' }).sort({ createdAt: -1 });
      const lastAssistantMsg = await Message.findOne({ conversation: chat._id, role: 'assistant' }).sort({ createdAt: -1 });
      if (lastAssistantMsg && (!lastUserMsg || lastAssistantMsg.createdAt >= lastUserMsg.createdAt)) {
        await lastAssistantMsg.deleteOne();
      }
      if (!lastUserMsg) throw new AppError('No message to regenerate', 400);
      triggerContent = lastUserMsg.content || '';
      triggerAttachments = lastUserMsg.attachments || [];
      if (!userMessageId) userMessageId = lastUserMsg._id;
    } else {
      const hasPayload = triggerContent || triggerAttachments.length > 0;
      if (!hasPayload) throw new AppError('Message content or attachments required', 400);
      triggerAttachments = await hydrateDocText(triggerAttachments);
      const createdUserMsg = await Message.create({
        conversation: chat._id,
        role: 'user',
        content: triggerContent,
        attachments: triggerAttachments,
      });
      userMessageId = createdUserMsg._id;
    }

    const developerQuery = isDeveloperQuery(triggerContent);

    const history = await Message.find({ conversation: chat._id })
      .sort({ createdAt: 1 })
      .limit(50)
      .select('role content attachments');

    const documents = buildDocuments(history);

    let memories = [];
    if (req.user.memoryEnabled) {
      memories = await Memory.find({ user: req.user._id }).limit(10).select('content');
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    res.write(`data: ${JSON.stringify({ chatId: chat._id.toString(), title: chat.title, ...(userMessageId ? { userMessageId } : {}) })}\n\n`);

    if (developerQuery) {
      res.write(`data: ${JSON.stringify({ type: 'developer_profile' })}\n\n`);
    }

    const actionRequest = detectAction(triggerContent || '');
    if (actionRequest) {
      let fullContent = '';
      if (actionRequest.type === 'action_confirmation') {
        res.write(`data: ${JSON.stringify(actionRequest)}\n\n`);
      } else {
        fullContent = buildUnsupportedMessage(actionRequest.target);
        res.write(`data: ${JSON.stringify({ content: fullContent })}\n\n`);
      }
      try {
        if (fullContent && !isSafeAiErrorMessage(fullContent)) {
          await Message.create({
            conversation: chat._id,
            role: 'assistant',
            content: fullContent,
          });
        }
        await setTitleIfDefault(chat, triggerContent, triggerAttachments);
        chat.updatedAt = new Date();
        await chat.save();
      } catch (err) {
        console.error('[Stream] Failed to persist action response:', err.message || err);
      }
      res.write(`data: [DONE]\n\n`);
      res.end();
      return;
    }

    const webStage = triggerAttachments.some(a => a.type === 'image')
      ? null
      : await runWebSearchStage(triggerContent || '', history);

    if (webStage && webStage.type === 'static') {
      res.write(`data: ${JSON.stringify({ content: webStage.content })}\n\n`);
      try {
        await Message.create({
          conversation: chat._id,
          role: 'assistant',
          content: webStage.content,
          metadata: webStage.metadata || {},
        });
        await setTitleIfDefault(chat, triggerContent, triggerAttachments);
        chat.updatedAt = new Date();
        await chat.save();
      } catch (err) {
        console.error('[Stream] Failed to persist web-search response:', err.message || err);
      }
      res.write(`data: [DONE]\n\n`);
      res.end();
      return;
    }

    if (webStage && webStage.type === 'search') {
      res.write(`data: ${JSON.stringify({ type: 'sources', sources: webStage.sources })}\n\n`);
    }

    let fullContent = '';
    let resource = null;

    try {
      const stream = await processMessage({
        messages: history.map(m => ({ role: m.role, content: m.content })),
        memories: memories.map(m => m.content),
        mode: chat.mode,
        attachments: triggerAttachments,
        userContent: triggerContent,
        documents,
        stream: true,
        webSearch: webStage && webStage.type === 'search'
          ? { sources: webStage.sources, images: webStage.images || [], text: webStage.contextText }
          : null,
        conversational: Boolean(webStage && webStage.conversational),
      });

      for await (const chunk of stream) {
        fullContent += chunk;
        res.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
      }

      // The resource card is validated and resolved once the stream ends.
      try {
        resource = stream && stream.resource ? await stream.resource : null;
      } catch (err) {
        console.warn('[Stream] resource resolution failed:', err?.message || err);
      }
      if (resource) {
        res.write(`data: ${JSON.stringify({ type: 'resource', resource })}\n\n`);
      }
    } catch (streamError) {
      console.error('[Stream Error] conversation=' + chat._id + ' mode=' + chat.mode + ' error:', streamError.message || streamError);
      const safeMessage = isSafeAiErrorMessage(streamError.message)
        ? streamError.message
        : 'Something went wrong while generating a response. Please try again.';
      res.write(`data: ${JSON.stringify({ error: safeMessage })}\n\n`);
    }

    try {
      if (fullContent && !isSafeAiErrorMessage(fullContent)) {
        await Message.create({
          conversation: chat._id,
          role: 'assistant',
          content: fullContent,
          metadata: {
            ...(developerQuery ? { developerProfile: true } : {}),
            ...(webStage && webStage.type === 'search' ? webStage.metadata : {}),
            ...(resource ? { resource } : {}),
          },
        });
      }
      await setTitleIfDefault(chat, triggerContent, triggerAttachments);
      chat.updatedAt = new Date();
      await chat.save();
    } catch (err) {
      console.error('[Stream] Failed to persist assistant message:', err.message || err);
    }

    res.write(`data: [DONE]\n\n`);
    res.end();
  } catch (err) {
    next(err);
  }
};

export const deleteAllChats = async (req, res, next) => {
  try {
    if (!req.user) throw new AppError('Authentication required', 401);
    const conversations = await Conversation.find({ user: req.user._id }).select('_id');
    const ids = conversations.map(c => c._id);
    await Message.deleteMany({ conversation: { $in: ids } });
    await Conversation.deleteMany({ user: req.user._id });
    success(res, null, 'All chats deleted');
  } catch (err) {
    next(err);
  }
};