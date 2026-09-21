import multer from 'multer';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { AppError } from './errorHandler.js';

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
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
