import { Router } from 'express';
import { getChats, createChat, getChat, updateChat, deleteChat, sendMessage, streamMessage, deleteAllChats, uploadChatFile, refreshAttachmentUrls } from '../controllers/chatController.js';
import { authenticate, optionalAuth, withRequestContext } from '../middleware/auth.js';
import { uploadAny } from '../middleware/upload.js';
import { aiLimiter, payloadLimiter } from '../middleware/rateLimiters.js';

const router = Router();

router.get('/', authenticate, getChats);
router.post('/', authenticate, createChat);
router.delete('/all', authenticate, deleteAllChats);

// Re-mint signed URLs for the attachments of one conversation. Declared BEFORE
// the '/:id' routes so a path like /chats/<id>/attachments/sign is never
// swallowed by a parameterised handler.
router.post('/:id/attachments/sign', authenticate, refreshAttachmentUrls);

router.get('/:id', authenticate, getChat);
router.patch('/:id', authenticate, updateChat);
router.delete('/:id', authenticate, deleteChat);

router.post('/message', optionalAuth, aiLimiter, sendMessage);
router.post('/stream', optionalAuth, aiLimiter, streamMessage);
// `withRequestContext` MUST sit between the multipart parser and the controller:
// multer's stream callbacks run outside the request's AsyncLocalStorage store,
// which would otherwise make the Storage upload use the anon client and be
// rejected by the owner-only RLS. See middleware/auth.js.
router.post('/upload', authenticate, payloadLimiter, uploadAny.single('file'), withRequestContext, uploadChatFile);

export default router;
