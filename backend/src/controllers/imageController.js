import { success } from '../utils/response.js';
import { AppError } from '../middleware/errorHandler.js';
import { analyzeImageBuffer } from '../services/aiService.js';
import { enhanceImageBuffer } from '../services/imageEnhance.js';
import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import * as storageService from '../services/storageService.js';

// Persist an image result as a real chat message so it survives refresh,
// logout/login and redeploys. The attachment stores the Supabase STORAGE KEY
// (never a disk path and never a signed URL, which expires); a fresh signed URL
// is re-minted on every read by withSignedUrls() when the conversation loads.
const persistImageMessage = async ({ user, conversationId, prompt, content, attachment }) => {
  let chat;
  if (conversationId) {
    chat = await Conversation.findOne({ _id: conversationId, user: user._id });
    if (!chat) throw new AppError('Chat not found', 404);
  } else {
    const title = String(prompt || '').trim().slice(0, 80) || 'New Chat';
    chat = await Conversation.create({ user: user._id, title });
  }
  if (prompt && String(prompt).trim()) {
    await Message.create({ conversation: chat._id, role: 'user', content: String(prompt) });
  }
  const assistantMessage = await Message.create({
    conversation: chat._id,
    role: 'assistant',
    content: content || '',
    attachments: [attachment],
  });
  chat.updatedAt = new Date();
  await chat.save();
  return { chat, assistantMessage };
};

export const enhance = async (req, res, next) => {
  let uploadedPath = null;
  try {
    if (!req.user) throw new AppError('Authentication required', 401);
    if (!req.file?.buffer) throw new AppError('No image uploaded', 400);
    const { buffer, mimetype, originalname } = req.file;
    const body = req.body || {};

    // Optimize / enhance the in-memory image and upload the RESULT to the
    // PRIVATE, owner-scoped Supabase Storage bucket so the enhanced image is
    // stored permanently. `authUid` comes from the request-scoped session (the
    // same authenticated client that uploads), so the object is created in
    // `user-{auth.uid()}/` and the owner RLS policy always applies.
    const enhanced = await enhanceImageBuffer({ buffer, mimetype });
    const outputName = `${Date.now()}-enhanced.png`;
    const uploaded = await storageService.uploadBuffer({
      authUid: req.authUserId || req.user._id?.toString(),
      buffer: enhanced.buffer,
      contentType: enhanced.mimetype,
      filename: originalname || outputName,
      ext: (enhanced.mimetype || '').includes('png') ? 'png' : 'jpeg',
    });
    uploadedPath = uploaded.path;

    // The persisted attachment deliberately holds only durable fields. The
    // signed `url` is attached to the RESPONSE for instant display and is
    // regenerated from `path` on every subsequent read.
    const attachment = {
      type: 'image',
      filename: outputName,
      path: uploaded.path,
      mimetype: enhanced.mimetype,
      size: enhanced.buffer.length,
    };

    const { chat, assistantMessage } = await persistImageMessage({
      user: req.user,
      conversationId: body.conversationId,
      prompt: '',
      content: 'Enhanced image — higher resolution, sharper detail, and improved lighting, colors, and clarity.',
      attachment,
    });

    // Sign the persisted attachment for the immediate response so the client
    // can render without a round-trip.
    const [signedAttachment] = await storageService.withSignedUrls([attachment]);

    success(res, {
      ...signedAttachment,
      id: uploaded.path,
      path: uploaded.path,
      url: signedAttachment?.url || uploaded.url,
      chatId: chat._id?.toString ? chat._id.toString() : chat._id,
      messageId: assistantMessage._id?.toString ? assistantMessage._id.toString() : assistantMessage._id,
      title: chat.title,
    });
  } catch (err) {
    // Don't leave an orphaned object in the bucket when persistence fails.
    if (uploadedPath) {
      try {
        await storageService.deleteObject(uploadedPath);
      } catch {
        /* best-effort cleanup */
      }
    }
    next(err);
  }
};

export const analyze = async (req, res, next) => {
  try {
    if (!req.user) throw new AppError('Authentication required', 401);
    if (!req.file?.buffer) throw new AppError('No image uploaded', 400);

    const { buffer, mimetype } = req.file;

    // The vision provider consumes raw bytes — pass the buffer straight
    // through (no disk round-trip, no storage round-trip). `analyze` is an
    // ephemeral, one-shot vision call: it returns the AI's text answer and
    // does not persist the image. To attach an image to a chat conversation,
    // use the chat upload flow (which stores it in the private bucket).
    const result = await analyzeImageBuffer({
      imageBuffer: buffer,
      mimetype,
      question: req.body?.question || undefined,
    });

    success(res, {
      content: result.content,
      metadata: result.metadata,
    });
  } catch (err) {
    next(err);
  }
};
