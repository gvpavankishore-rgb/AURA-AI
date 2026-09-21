import { Router } from 'express';
import { transcribe, speak } from '../controllers/voiceController.js';
import { authenticate } from '../middleware/auth.js';
import { uploadAny } from '../middleware/upload.js';
import { aiLimiter } from '../middleware/rateLimiters.js';

const router = Router();
router.post('/transcribe', authenticate, aiLimiter, uploadAny.single('audio'), transcribe);
router.post('/speak', authenticate, aiLimiter, speak);

export default router;
