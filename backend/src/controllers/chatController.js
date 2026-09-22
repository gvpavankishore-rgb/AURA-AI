import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import Memory from '../models/Memory.js';
import path from 'path';
import { AppError } from '../middleware/errorHandler.js';
import { success, created } from '../utils/response.js';
import { processMessage, isSafeAiErrorMessage } from '../services/aiService.js';
import { extractTextFromFile } from '../services/documentText.js';
import { detectAction, buildUnsupportedMessage } from '../services/actionDetector.js';
import { isDeveloperQuery } from '../services/developerInfo.js';
import { isCodingRequest } from '../services/intentDetector.js';
import * as webSearchService from '../services/webSearchService.js';
import { detectWebSearchIntent } from '../services/webSearchDetector.js';
import * as weatherService from '../services/weatherService.js';

const MAX_DOC_CONTEXT = 24000;
const CHAT_PAGE_DEFAULT_LIMIT = 50;
const CHAT_PAGE_MAX_LIMIT = 100;

const CHAT_MODES = ['chat', 'coding', 'voice', 'documents', 'translate'];

const ASK_LOCATION_MESSAGE = 'Which city or location should I check the weather for?';
const ASK_LOCATION_FULL = `${ASK_LOCATION_MESSAGE} For example: "weather in Hyderabad" or "what is the temperature in London today?"`;

// Web-search / live-data pipeline stage helper:
//  - "none"   -> normal OpenRouter flow (no live info requested)
//  - "static" -> answer without the AI (real weather, weather location prompt,
//                search temporarily unavailable or returned no results)
//  - "search" -> perform the web search, attach sources + context for the AI
const runWebSearchStage = async (content) => {
  const intent = detectWebSearchIntent(content || '');
  if (!intent.needsSearch) return { type: 'none' };

  // Dedicated real-time weather: bypasses OpenRouter entirely and returns a
  // clean AURA-style weather block. Falls back to web search only when the
  // weather service is not configured.
  if (intent.weather) {
    if (!intent.location) {
      return { type: 'static', content: ASK_LOCATION_FULL };
    }
    const weatherResult = await weatherService.tryGetWeather(intent.location);
    if (weatherResult.type === 'ok') {
      return { type: 'static', content: weatherResult.message, metadata: weatherResult.metadata };
    }
    if (weatherResult.type === 'error') {
      return { type: 'static', content: weatherResult.message, metadata: { weather: { used: true, error: true } } };
    }
    console.warn('[Weather] WEATHER_API_KEY missing — falling back to web search for weather query.');
  }

  try {
    const result = await webSearchService.searchWeb(content || '');
    if (!result.enabled) {
      console.warn('[WebSearch] WEB_SEARCH_ENABLED is not true; skipping live web search for this message.');
      return { type: 'none' };
    }
    if (result.results.length === 0) {
      return {
        type: 'static',
        content: webSearchService.SEARCH_NO_RESULTS_MESSAGE,
        metadata: { webSearch: { used: true, sources: [] } },
      };
    }
    return {
      type: 'search',
      sources: result.results,
      contextText: webSearchService.buildSearchContext(result.results),
      metadata: { webSearch: { used: true, sources: result.results } },
    };
  } catch (err) {
    console.error('[WebSearch] Failed:', err?.message || err);
    return {
      type: 'static',
      content: webSearchService.SEARCH_UNAVAILABLE_MESSAGE,
      metadata: { webSearch: { used: true, sources: [] } },
    };
  }
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

const hydrateDocText = async (attachments) => {
  for (const att of (attachments || []).filter(Boolean)) {
    if (att.type !== 'document' || !att.path || att.text) continue;
    try {
      const text = await extractTextFromFile(path.resolve(process.cwd(), att.path), att.filename);
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
    success(res, { chat, messages });
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
    if (!req.file) throw new AppError('No file uploaded', 400);
    const type = req.file.mimetype.startsWith('image/') ? 'image' : 'document';
    success(res, {
      id: req.file.filename,
      filename: req.file.originalname,
      path: req.file.path,
      mimetype: req.file.mimetype,
      type,
      size: req.file.size,
    });
  } catch (err) {
    next(err);
  }
};

export const sendMessage = async (req, res, next) => {
  try {
    if (!req.user) throw new AppError('Authentication required', 401);
    const { conversationId, content, attachments, mode } = req.body;
    if (!content && (!attachments || attachments.length === 0)) {
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

    const hydratedAttachments = await hydrateDocText(attachments || []);

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
        return success(res, { chat, userMessage, assistantMessage });
      }

      await setTitleIfDefault(chat, content, hydratedAttachments);
      chat.updatedAt = new Date();
      await chat.save();
      return success(res, { chat, userMessage, action: actionRequest });
    }

    const webStage = await runWebSearchStage(content || '');

    if (webStage.type === 'static') {
      const assistantMessage = await Message.create({
        conversation: chat._id,
        role: 'assistant',
        content: webStage.content,
        metadata: webStage.metadata || {},
      });
      await setTitleIfDefault(chat, content, hydratedAttachments);
      chat.updatedAt = new Date();
      await chat.save();
      return success(res, { chat, userMessage, assistantMessage });
    }

    const aiResponse = await processMessage({
      messages: history.map(m => ({ role: m.role, content: m.content })),
      memories: memories.map(m => m.content),
      mode: chat.mode,
      attachments: hydratedAttachments,
      userContent: content,
      documents,
      webSearch: webStage.type === 'search'
        ? { sources: webStage.sources, text: webStage.contextText }
        : null,
    });

    const assistantMessage = await Message.create({
      conversation: chat._id,
      role: 'assistant',
      content: aiResponse.content,
      metadata: {
        ...(aiResponse.metadata || {}),
        ...(webStage.type === 'search' ? webStage.metadata : {}),
        ...(isDeveloperQuery(content || '') ? { developerProfile: true } : {}),
      },
    });

    await setTitleIfDefault(chat, content, hydratedAttachments);
    chat.updatedAt = new Date();
    await chat.save();

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
    if (!req.user) throw new AppError('Authentication required', 401);
    const { conversationId, content, attachments, regenerate, editMessageId, mode } = req.body;

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
    let triggerAttachments = attachments || [];

    let isEdit = false;
    if (editMessageId) {
      const targetMsg = await Message.findOne({ _id: editMessageId, conversation: chat._id, role: 'user' });
      if (!targetMsg) throw new AppError('Message not found to edit', 404);
      triggerAttachments = await hydrateDocText(triggerAttachments);
      targetMsg.content = triggerContent;
      targetMsg.attachments = triggerAttachments;
      await targetMsg.save();
      await Message.deleteMany({ conversation: chat._id, createdAt: { $gt: targetMsg.createdAt } });
      isEdit = true;
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
    } else {
      const hasPayload = triggerContent || triggerAttachments.length > 0;
      if (!hasPayload) throw new AppError('Message content or attachments required', 400);
      triggerAttachments = await hydrateDocText(triggerAttachments);
      await Message.create({
        conversation: chat._id,
        role: 'user',
        content: triggerContent,
        attachments: triggerAttachments,
      });
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

    res.write(`data: ${JSON.stringify({ chatId: chat._id.toString(), title: chat.title })}\n\n`);

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

    const webStage = await runWebSearchStage(triggerContent || '');

    if (webStage.type === 'static') {
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

    if (webStage.type === 'search') {
      res.write(`data: ${JSON.stringify({ type: 'sources', sources: webStage.sources })}\n\n`);
    }

    let fullContent = '';

    try {
      const stream = await processMessage({
        messages: history.map(m => ({ role: m.role, content: m.content })),
        memories: memories.map(m => m.content),
        mode: chat.mode,
        attachments: triggerAttachments,
        userContent: triggerContent,
        documents,
        stream: true,
        webSearch: webStage.type === 'search'
          ? { sources: webStage.sources, text: webStage.contextText }
          : null,
      });

      for await (const chunk of stream) {
        fullContent += chunk;
        res.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
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
            ...(webStage.type === 'search' ? webStage.metadata : {}),
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