import sharp from 'sharp';
import { AppError } from '../middleware/errorHandler.js';

const UPSCALE = 2;
const MAX_SIDE = 2048;

/**
 * Real, deterministic image enhancement, run entirely on an in-memory buffer:
 *  - auto-orient (EXIF rotation)
 *  - upscale (2x, capped at MAX_SIDE on either dimension)
 *  - sharpen
 *  - light noise reduction (median)
 *  - brightness / saturation / mild contrast boost
 *
 * Returns the enhanced PNG as a Buffer plus its dimensions. The caller
 * (controllers/imageController.js) uploads that buffer to Supabase Storage, so
 * this module never writes to disk and the original is never mutated.
 */
export const enhanceImageBuffer = async ({ buffer, mimetype = '' }) => {
  if (!buffer || !Buffer.isBuffer(buffer)) {
    throw new AppError('Image file not found', 400);
  }

  let oriented;
  try {
    oriented = await sharp(buffer, { failOn: 'none' }).rotate().metadata();
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

  let out;
  try {
    out = await sharp(buffer, { failOn: 'none' })
      .rotate()
      .resize(width, height, { fit: 'fill' })
      .sharpen({ sigma: 1 })
      .median(1)
      .modulate({ brightness: 1.04, saturation: 1.12 })
      .linear(1.06, -8)
      .png()
      .toBuffer();
  } catch (err) {
    console.error('[ImageEnhance] Could not enhance the image:', err?.message || err);
    throw new AppError('Could not enhance the image', 500);
  }

  return {
    buffer: out,
    mimetype: 'image/png',
    origWidth,
    origHeight,
    width,
    height,
  };
};
