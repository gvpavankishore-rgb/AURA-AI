export const MAX_IMAGE_DIMENSION = 1600;
export const IMAGE_COMPRESS_QUALITY = 0.85;
const COMPRESS_SIZE_THRESHOLD = 400 * 1024;

const RASTER_TYPES = /^image\/(png|jpe?g|webp|bmp)$/i;
const ALPHA_TYPES = /^image\/(png|webp|bmp)$/i;

let webpSupported;

function supportsWebp() {
  if (webpSupported === undefined) {
    try {
      const c = document.createElement('canvas');
      c.width = 1;
      c.height = 1;
      webpSupported = c.toDataURL('image/webp').startsWith('data:image/webp');
    } catch {
      webpSupported = false;
    }
  }
  return webpSupported;
}

function loadViaImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ source: img, close: null, url });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read image'));
    };
    img.src = url;
  });
}

function loadImage(file) {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(file)
      .then(bitmap => ({ source: bitmap, close: () => bitmap.close(), url: null }))
      .catch(() => loadViaImage(file));
  }
  return loadViaImage(file);
}

function detectAlpha(source, w, h) {
  try {
    const sw = Math.max(1, Math.min(w, 64));
    const sh = Math.max(1, Math.min(h, 64));
    const c = document.createElement('canvas');
    c.width = sw;
    c.height = sh;
    const g = c.getContext('2d', { willReadFrequently: true });
    if (!g) return false;
    g.drawImage(source, 0, 0, w, h, 0, 0, sw, sh);
    const data = g.getImageData(0, 0, sw, sh).data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 250) return true;
    }
  } catch { /* assume opaque */ }
  return false;
}

/**
 * Compress / downscale an image on the client before upload.
 * Returns `{ file, changed }` where `changed` is false when the image is
 * already small enough to skip compression.
 */
export function compressImage(file, { maxDimension = MAX_IMAGE_DIMENSION, quality = IMAGE_COMPRESS_QUALITY, onProgress } = {}) {
  const report = (p) => onProgress?.(Math.round(Math.max(0, Math.min(100, p))));

  return new Promise((resolve) => {
    const mime = file?.type || '';
    if (!RASTER_TYPES.test(mime)) return resolve({ file, changed: false });

    report(10);

    loadImage(file)
      .then(({ source, close, url }) => {
        const w = source.naturalWidth || source.width;
        const h = source.naturalHeight || source.height;
        if (!w || !h) {
          if (url) URL.revokeObjectURL(url);
          if (close) close();
          return resolve({ file, changed: false });
        }
        const scale = Math.min(1, maxDimension / Math.max(w, h));
        if (file.size <= COMPRESS_SIZE_THRESHOLD && scale >= 1) {
          if (url) URL.revokeObjectURL(url);
          if (close) close();
          report(100);
          return resolve({ file, changed: false });
        }

        report(35);
        // Let the browser paint the "Optimizing…" state before doing heavy work.
        setTimeout(() => {
          const hasTransparency = ALPHA_TYPES.test(mime) && detectAlpha(source, w, h);
          const outType = hasTransparency
            ? (supportsWebp() ? 'image/webp' : 'image/png')
            : 'image/jpeg';

          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(w * scale));
          canvas.height = Math.max(1, Math.round(h * scale));

          const g = canvas.getContext('2d');
          if (g && outType === 'image/jpeg') {
            g.fillStyle = '#ffffff';
            g.fillRect(0, 0, canvas.width, canvas.height);
          }
          g?.drawImage(source, 0, 0, w, h, 0, 0, canvas.width, canvas.height);

          report(65);
          setTimeout(() => {
            canvas.toBlob((blob) => {
              if (url) URL.revokeObjectURL(url);
              if (close) close();
              if (!blob) return resolve({ file, changed: false });
              report(90);
              const ext = outType === 'image/jpeg' ? 'jpg' : outType === 'image/webp' ? 'webp' : 'png';
              const baseName = (file.name || 'image').replace(/\.[^.]+$/i, '');
              const outFile = new File([blob], `${baseName}.${ext}`, { type: outType });
              report(100);
              resolve({ file: outFile, changed: true, width: canvas.width, height: canvas.height });
            }, outType, quality);
          }, 0);
        }, 0);
      })
      .catch(() => resolve({ file, changed: false }));
  });
}