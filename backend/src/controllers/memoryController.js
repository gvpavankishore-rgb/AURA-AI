import Memory from '../models/Memory.js';
import { AppError } from '../middleware/errorHandler.js';
import { success, created } from '../utils/response.js';

export const getMemories = async (req, res, next) => {
  try {
    const memories = await Memory.find({ user: req.user._id }).sort({ createdAt: -1 });
    success(res, memories);
  } catch (err) {
    next(err);
  }
};

export const addMemory = async (req, res, next) => {
  try {
    const { content, type } = req.body;
    if (!content) throw new AppError('Content is required', 400);
    const memory = await Memory.create({ user: req.user._id, content, type: type || 'custom' });
    created(res, memory);
  } catch (err) {
    next(err);
  }
};

export const deleteMemory = async (req, res, next) => {
  try {
    const memory = await Memory.findOneAndDelete({ _id: req.params.id, user: req.user._id });
    if (!memory) throw new AppError('Memory not found', 404);
    success(res, null, 'Memory deleted');
  } catch (err) {
    next(err);
  }
};

export const clearMemories = async (req, res, next) => {
  try {
    await Memory.deleteMany({ user: req.user._id });
    success(res, null, 'All memories cleared');
  } catch (err) {
    next(err);
  }
};
