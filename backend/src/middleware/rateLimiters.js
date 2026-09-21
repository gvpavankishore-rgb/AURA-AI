import rateLimit from 'express-rate-limit';

const tooMany = (message) => ({ success: false, message });

const userOrIpKey = (req) => (req.user?.id ? `user:${req.user.id}` : `ip:${req.ip}`);

/**
 * Applies to every /api route. Broad protection against abuse and
 * brute-force surfers while staying well above legitimate usage.
 */
export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: tooMany('Too many requests. Please try again later.'),
});

/**
 * Stricter per-user (or per-IP for guests) budget for expensive AI routes.
 * Each hit triggers server-side AI work, so bursts are capped well below
 * the global ceiling to limit cost exposure.
 */
export const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  keyGenerator: userOrIpKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: tooMany('AI request limit reached. Please try again in a moment.'),
});

/**
 * Protects request bodies from being abused by oversized payloads before
 * multer / JSON parsing work happens.
 */
export const payloadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: userOrIpKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: tooMany('Too many uploads. Please slow down.'),
});