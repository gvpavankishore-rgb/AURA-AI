import { AppError } from '../middleware/errorHandler.js';
import { success } from '../utils/response.js';
import { transcribeAudio, textToSpeech } from '../services/aiService.js';

export const transcribe = async (req, res, next) => {
  try {
    if (!req.file) throw new AppError('Audio file is required', 400);
    const result = await transcribeAudio(req.file.path);
    success(res, result);
  } catch (err) {
    next(err);
  }
};

export const speak = async (req, res, next) => {
  try {
    const { text, voice, speed } = req.body;
    if (!text) throw new AppError('Text is required', 400);
    const result = await textToSpeech(text, voice || 'alloy', speed || 1);
    res.set({ 'Content-Type': 'audio/mpeg', 'Content-Disposition': 'inline' });
    res.send(Buffer.from(result.audio, 'base64'));
  } catch (err) {
    next(err);
  }
};
