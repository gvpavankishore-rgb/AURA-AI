import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import Jimp from 'jimp';
import { AppError } from '../middleware/errorHandler.js';

const UPSCALE = 2;
const MAX_SIDE = 2048;
const uploadsRoot = path.resolve(process.cwd(), 'uploads');
const aiDir = path.join(uploadsRoot, 'ai');

const ensureDir = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
};

export const enhanceImage = async (inputPath) => {
  if (!fs.existsSync(inputPath)) throw new AppError('Image file not found', 400);
  ensureDir(aiDir);

  let image;
  try {
    image = await Jimp.read(inputPath);
  } catch {
    throw new AppError('Could not read the image file', 400);
  }

  const origWidth = image.bitmap.width;
  const origHeight = image.bitmap.height;

  let scale = UPSCALE;
  if (origWidth * scale > MAX_SIDE || origHeight * scale > MAX_SIDE) {
    scale = Math.min(MAX_SIDE / origWidth, MAX_SIDE / origHeight);
  }
  const width = Math.max(1, Math.round(origWidth * scale));
  const height = Math.max(1, Math.round(origHeight * scale));

  image.resize(width, height, { mode: Jimp.RESIZE_BEZIER });
  image.sharpen(1);
  image.contrast(0.08);
  image.brightness(0.02);
  try {
    image.color([{ apply: 'saturate', params: [12] }]);
  } catch { /* saturation not supported for this format */ }
  try {
    image.normalize();
  } catch { /* normalize not supported */ }

  const outName = `${uuidv4()}.png`;
  const outPath = path.join(aiDir, outName);
  try {
    await image.writeAsync(outPath);
  } catch {
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