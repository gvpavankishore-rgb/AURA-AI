import { Router } from 'express';
import { enhance, analyze } from '../controllers/imageController.js';
import { authenticate } from '../middleware/auth.js';
import { uploadImage } from '../middleware/upload.js';
import { aiLimiter } from '../middleware/rateLimiters.js';

const router = Router();
router.post('/enhance', authenticate, aiLimiter, uploadImage.single('image'), enhance);
router.post('/analyze', authenticate, aiLimiter, uploadImage.single('image'), analyze);

export default router;