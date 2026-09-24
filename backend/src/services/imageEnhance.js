import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import sharp from 'sharp';
import { AppError } from '../middleware/errorHandler.js';

const UPSCALE = 2;
const MAX_SIDE = 2048;
const uploadsRoot = path.resolve(process.cwd(), 'uploads');
const aiDir = path.join(uploadsRoot, 'ai');

const ensureDir = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
};

/**
 * Real, deterministic image enhancement:
 *  - auto-orient (EXIF rotation)
 *  - upscale (2x, capped at MAX_SIDE on either dimension)
 *  - sharpen
 *  - light noise reduction (median)
 *  - brightness / saturation / mild contrast boost
 *
 * The original file is always preserved; a NEW enhanced PNG is written to
 * uploads/ai/ so the source image is never mutated.
 */
export const enhanceImage = async (inputPath) => {
  if (!fs.existsSync(inputPath)) throw new AppError('Image file not found', 400);

  let oriented;
  try {
    oriented = await sharp(inputPath, { failOn: 'none' }).rotate().metadata();
  } catch {
    throw new AppError('Could not read the image file', 400);
  }

  const origWidth = oriented.width || 1;
  const origHeight = oriented.height || 1;

  let scale = UPSCALE;
  if (origWidth * scale > MAX_SIDE || origHeight * scale > MAX_SIDE) {
    scale = Math.min(MAX_SIDE / origWidth, MAX_SIDE / origHeight);
  }
  const width = Math.max(1, Math.round(origWidth * scale));
  const height = Math.max(1, Math.round(origHeight * scale));

  ensureDir(aiDir);
  const outName = `${uuidv4()}.png`;
  const outPath = path.join(aiDir, outName);

  try {
    await sharp(inputPath, { failOn: 'none' })
      .rotate()
      .resize(width, height, { fit: 'fill' })
      .sharpen({ sigma: 1 })
      .median(1)
      .modulate({ brightness: 1.04, saturation: 1.12 })
      .linear(1.06, -8)
      .png()
      .toFile(outPath);
  } catch (err) {
    console.error('[ImageEnhance] Could not save the enhanced image:', err?.message || err);
    throw new AppError('Could not save the enhanced image', 500);
  }

  return {
    path: `uploads/ai/${outName}`,
    origWidth,
    origHeight,
    width,
    height,
  };
};