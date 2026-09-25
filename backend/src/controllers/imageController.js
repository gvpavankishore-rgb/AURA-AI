import { success, created } from '../utils/response.js';
import { AppError } from '../middleware/errorHandler.js';
import { analyzeImageBuffer } from '../services/aiService.js';
import { enhanceImageBuffer } from '../services/imageEnhance.js';
import * as storageService from '../services/storageService.js';

export const enhance = async (req, res, next) => {
  try {
    if (!req.user) throw new AppError('Authentication required', 401);
    if (!req.file?.buffer) throw new AppError('No image uploaded', 400);
    const { buffer, mimetype, originalname } = req.file;

    // Optimize / enhance the in-memory image and upload the RESULT back to
    // Supabase Storage (private bucket, owner-scoped) so we never persist a
    // disk path. Uses `authUid` from the request-scoped session (the same
    // authenticated client that created the object, so RLS always passes).
    const enhanced = await enhanceImageBuffer({ buffer, mimetype });
    const uploaded = await storageService.uploadBuffer({
      authUid: req.authUserId || req.user._id?.toString(),
      buffer: enhanced.buffer,
      contentType: enhanced.mimetype,
      filename: originalname || `enhanced-${Date.now()}.png`,
      ext: (enhanced.mimetype || '').includes('png') ? 'png' : 'jpeg',
    });

    success(res, {
      id: uploaded.path,
      filename: `${Date.now()}-enhanced.png`,
      path: uploaded.path,
      url: uploaded.url,
      mimetype: enhanced.mimetype,
      type: 'image',
      size: enhanced.buffer.length,
    });
  } catch (err) {
    next(err);
  }
};

export const analyze = async (req, res, next) => {
  try {
    if (!req.user) throw new AppError('Authentication required', 401);
    if (!req.file?.buffer) throw new AppError('No image uploaded', 400);

    const { buffer, mimetype, originalname } = req.file;

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
