import { Router } from 'express';
import { translate } from '../controllers/translateController.js';
import { authenticate } from '../middleware/auth.js';
import { aiLimiter } from '../middleware/rateLimiters.js';

const router = Router();
router.post('/', authenticate, aiLimiter, translate);

export default router;
