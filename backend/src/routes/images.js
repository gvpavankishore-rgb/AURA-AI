import { Router } from 'express';
import { enhance, analyze } from '../controllers/imageController.js';
import { authenticate, withRequestContext } from '../middleware/auth.js';
import { uploadImage } from '../middleware/upload.js';
import { aiLimiter } from '../middleware/rateLimiters.js';

const router = Router();
// withRequestContext restores the request's Supabase store after multer so the
// enhance flow persists the result under the caller's own user-<uid>/ folder
// instead of falling back to the anon client (owner-only RLS would reject it).
// See middleware/auth.js.
router.post('/enhance', authenticate, aiLimiter, uploadImage.single('image'), withRequestContext, enhance);
router.post('/analyze', authenticate, aiLimiter, uploadImage.single('image'), withRequestContext, analyze);

export default router;