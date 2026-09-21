import { Router } from 'express';
import { getMemories, addMemory, deleteMemory, clearMemories } from '../controllers/memoryController.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();
router.get('/', authenticate, getMemories);
router.post('/', authenticate, addMemory);
router.delete('/:id', authenticate, deleteMemory);
router.delete('/', authenticate, clearMemories);

export default router;
