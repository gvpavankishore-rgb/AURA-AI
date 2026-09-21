import UserSettings from '../models/UserSettings.js';
import { success } from '../utils/response.js';

export const getSettings = async (req, res, next) => {
  try {
    let settings = await UserSettings.findOne({ user: req.user._id });
    if (!settings) {
      settings = await UserSettings.create({ user: req.user._id });
    }
    success(res, settings);
  } catch (err) {
    next(err);
  }
};

export const updateSettings = async (req, res, next) => {
  try {
    const allowed = ['theme', 'language', 'voiceId', 'voiceSpeed', 'autoPlayVoice', 'enterToSend', 'showTimestamps', 'streamingEnabled', 'memoryEnabled'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    const settings = await UserSettings.findOneAndUpdate(
      { user: req.user._id },
      updates,
      { new: true, upsert: true }
    );
    success(res, settings);
  } catch (err) {
    next(err);
  }
};
