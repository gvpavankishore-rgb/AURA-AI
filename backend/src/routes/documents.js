import { Router } from 'express';
import { uploadDocument, getDocuments, getDocument, deleteDocument, askDocument, summarizeDocument } from '../controllers/documentController.js';
import { authenticate } from '../middleware/auth.js';
import { uploadDocument as upload } from '../middleware/upload.js';
import { aiLimiter, payloadLimiter } from '../middleware/rateLimiters.js';

const router = Router();
router.post('/upload', authenticate, payloadLimiter, upload.single('file'), uploadDocument);
router.get('/', authenticate, getDocuments);
router.get('/:id', authenticate, getDocument);
router.delete('/:id', authenticate, deleteDocument);
router.post('/:id/ask', authenticate, aiLimiter, askDocument);
router.post('/:id/summarize', authenticate, aiLimiter, summarizeDocument);

export default router;
