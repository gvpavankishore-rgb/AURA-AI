import User from '../models/User.js';
import UserSettings from '../models/UserSettings.js';
import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import Document from '../models/Document.js';
import Memory from '../models/Memory.js';
import { success } from '../utils/response.js';
import fs from 'fs';

export const getMe = async (req, res, next) => {
  try {
    let settings = await UserSettings.findOne({ user: req.user._id });
    if (!settings) {
      settings = await UserSettings.create({ user: req.user._id });
    }
    success(res, { user: req.user, settings });
  } catch (err) {
    next(err);
  }
};

export const updateMe = async (req, res, next) => {
  try {
    const { name, avatar } = req.body;
    const updates = {};
    if (name) updates.name = name;
    if (avatar !== undefined) updates.avatar = avatar;
    const user = await User.findOneAndUpdate({ _id: req.user._id }, updates, { new: true });
    success(res, user);
  } catch (err) {
    next(err);
  }
};

export const deleteAccount = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const conversations = await Conversation.find({ user: userId }).select('_id');
    const convIds = conversations.map(c => c._id);

    await Message.deleteMany({ conversation: { $in: convIds } });
    await Conversation.deleteMany({ user: userId });
    await Document.deleteMany({ user: userId });
    await Memory.deleteMany({ user: userId });
    await User.findOneAndDelete({ _id: userId });

    success(res, null, 'Account deleted');
  } catch (err) {
    next(err);
  }
};
