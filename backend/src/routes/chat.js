import { Router } from 'express';
import { getChats, createChat, getChat, updateChat, deleteChat, sendMessage, streamMessage, deleteAllChats, uploadChatFile } from '../controllers/chatController.js';
import { authenticate, optionalAuth } from '../middleware/auth.js';
import { uploadAny } from '../middleware/upload.js';
import { aiLimiter, payloadLimiter } from '../middleware/rateLimiters.js';

const router = Router();

router.get('/', authenticate, getChats);
router.post('/', authenticate, createChat);
router.delete('/all', authenticate, deleteAllChats);

router.get('/:id', authenticate, getChat);
router.patch('/:id', authenticate, updateChat);
router.delete('/:id', authenticate, deleteChat);

router.post('/message', optionalAuth, aiLimiter, sendMessage);
router.post('/stream', optionalAuth, aiLimiter, streamMessage);
router.post('/upload', authenticate, payloadLimiter, uploadAny.single('file'), uploadChatFile);

export default router;
