import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { AppError } from '../middleware/errorHandler.js';
import { success } from '../utils/response.js';
import { generateImage, analyzeImage } from '../services/aiService.js';
import { enhanceImage } from '../services/imageEnhance.js';
import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';

const aiDir = path.resolve(process.cwd(), 'uploads', 'ai');

const ensureAiDir = () => fs.mkdirSync(aiDir, { recursive: true });

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
  await Message.create({
    conversation: chat._id,
    role: 'assistant',
    content: content || '',
    attachments: [attachment],
  });
  chat.updatedAt = new Date();
  await chat.save();
  return chat;
};

export const generate = async (req, res, next) => {
  try {
    const body = req.body || {};
    const { prompt, size, conversationId } = body;
    if (!prompt || !String(prompt).trim()) throw new AppError('Prompt is required', 400);
    const result = await generateImage(String(prompt), size || '1024x1024');
    console.log(`[Images] generate "${String(prompt).slice(0, 60)}" -> ${result.mediaType}, ${Math.round((result.image.length * 3) / 4 / 1024)} KB image returned (OpenAI API).`);
    let chatId = null;
    if (req.user) {
      ensureAiDir();
      const buffer = Buffer.from(result.image, 'base64');
      const mime = result.mediaType || 'image/png';
      const ext = mime.includes('png') ? 'png' : mime.includes('svg') ? 'svg' : mime.includes('webp') ? 'webp' : 'jpg';
      const name = `${uuidv4()}.${ext}`;
      fs.writeFileSync(path.join(aiDir, name), buffer);
      const chat = await persistImageMessage({
        user: req.user,
        conversationId,
        prompt: String(prompt),
        content: result.revisedPrompt || String(prompt),
        attachment: {
          type: 'image',
          filename: '',
          path: `uploads/ai/${name}`,
          mimetype: mime,
        },
      });
      chatId = chat._id;
      console.log(`[Images] Persisted generated image to uploads/ai/${name} (chat ${String(chatId)})`);
    }
    success(res, { image: result.image, mediaType: result.mediaType, revisedPrompt: result.revisedPrompt, chatId });
  } catch (err) {
    next(err);
  }
};

export const enhance = async (req, res, next) => {
  try {
    if (!req.file) throw new AppError('Image file is required', 400);
    const body = req.body || {};
    const enhanced = await enhanceImage(req.file.path);
    let chatId = null;
    if (req.user) {
      const chat = await persistImageMessage({
        user: req.user,
        conversationId: body.conversationId,
        prompt: '',
        content: 'Enhanced image — higher resolution, sharper detail, and improved lighting, colors, and clarity.',
        attachment: {
          type: 'image',
          filename: '',
          path: enhanced.path,
          mimetype: 'image/png',
        },
      });
      chatId = chat._id;
    }
    success(res, { ...enhanced, chatId });
  } catch (err) {
    next(err);
  }
};

export const analyze = async (req, res, next) => {
  try {
    if (!req.file) throw new AppError('Image file is required', 400);
    const { question } = req.body;
    const result = await analyzeImage(req.file.path, question || 'Describe this image in detail');
    success(res, result);
  } catch (err) {
    next(err);
  }
};