import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { AppError } from '../middleware/errorHandler.js';
import { success } from '../utils/response.js';
import { analyzeImage } from '../services/aiService.js';
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