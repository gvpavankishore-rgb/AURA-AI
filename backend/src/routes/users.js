import { Router } from 'express';
import { getMe, updateMe, deleteAccount } from '../controllers/userController.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();
router.get('/me', authenticate, getMe);
router.patch('/me', authenticate, updateMe);
router.delete('/me', authenticate, deleteAccount);

export default router;
