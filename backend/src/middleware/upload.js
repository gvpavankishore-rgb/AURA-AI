import multer from 'multer';
import { AppError } from './errorHandler.js';

// Multer now uses MEMORY STORAGE. Uploaded bytes arrive on `req.file.buffer`
// (never written to the backend filesystem) and every attachment is persisted
// to the PRIVATE Supabase Storage bucket through src/services/storageService.js
// (uploadBuffer) — which scopes every object to `user-{auth.uid()}/` and
// returns a fresh signed URL. The old diskStorage + uploads/ directory are
// gone: nothing in production (Render ephemeral disk, clean clones, Windows
// local) depends on a filesystem path anymore. File type policies and size
// limits are unchanged — this only moves where bytes live.

const memoryStorage = multer.memoryStorage();

const allowedImageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const allowedDocTypes = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/csv',
  'text/markdown',
];
const allowedCodeTypes = [
  'text/javascript', 'text/typescript', 'text/x-python', 'text/x-java',
  'text/x-c', 'text/x-c++', 'text/html', 'text/css', 'text/x-sql',
  'application/json', 'application/xml',
];
const allowedAudioTypes = [
  'audio/webm', 'audio/mp3', 'audio/mpeg', 'audio/wav', 'audio/x-wav',
  'audio/ogg', 'audio/x-m4a', 'audio/aac', 'video/webm',
];

export const uploadImage = multer({
  storage: memoryStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (allowedImageTypes.includes(file.mimetype)) cb(null, true);
    else cb(new AppError('Only JPEG, PNG, GIF, and WebP images are allowed', 400));
  },
});

export const uploadDocument = multer({
  storage: memoryStorage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if ([...allowedDocTypes, ...allowedCodeTypes].includes(file.mimetype)) cb(null, true);
    else cb(new AppError('File type not supported', 400));
  },
});

export const uploadAny = multer({
  storage: memoryStorage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allAllowed = [...allowedImageTypes, ...allowedDocTypes, ...allowedCodeTypes, ...allowedAudioTypes];
    if (allAllowed.includes(file.mimetype)) cb(null, true);
    else cb(new AppError('File type not supported', 400));
  },
});
