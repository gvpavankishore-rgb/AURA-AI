import { Router } from 'express';
import { getSettings, updateSettings } from '../controllers/settingsController.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();
router.get('/', authenticate, getSettings);
router.patch('/', authenticate, updateSettings);

export default router;
