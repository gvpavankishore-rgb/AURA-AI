import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { AppError } from './errorHandler.js';

// multer's diskStorage does NOT create the destination directory: it calls
// file.writeFile(path) directly asi, so on a fresh production checkout where
// uploads/ is gitignored (and on Render's ephemeral disk) the first upload
// fails with ENOENT -> 500. Ensure the directory exists before every write so
// uploads work out of the box on a clean clone, locally, and in production.
const ensureUploadDir = (dir) => {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.error('[Upload][mkdir] failed to create upload dir:', dir, '->', err?.message || err);
  }
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = 'uploads/';
    ensureUploadDir(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  },
});

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
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (allowedImageTypes.includes(file.mimetype)) cb(null, true);
    else cb(new AppError('Only JPEG, PNG, GIF, and WebP images are allowed', 400));
  },
});

export const uploadDocument = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if ([...allowedDocTypes, ...allowedCodeTypes].includes(file.mimetype)) cb(null, true);
    else cb(new AppError('File type not supported', 400));
  },
});

export const uploadAny = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allAllowed = [...allowedImageTypes, ...allowedDocTypes, ...allowedCodeTypes, ...allowedAudioTypes];
    if (allAllowed.includes(file.mimetype)) cb(null, true);
    else cb(new AppError('File type not supported', 400));
  },
});
