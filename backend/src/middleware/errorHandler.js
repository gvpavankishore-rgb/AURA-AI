const now = () => new Date().toISOString();

export const errorHandler = (err, req, res, next) => {
  const statusCode = err.status || err.statusCode || 500;
  const method = req?.method || '?';
  const url = req?.originalUrl || req?.url || '?';
  const requestId = req?.id || '-';

  if (statusCode >= 500) {
    console.error(`[Error:${now()}] ${method} ${url} [${requestId}] -> ${statusCode}`);
    console.error('  ' + (err.message || 'Unknown error'));
    if (err.stack) console.error(err.stack);
  } else {
    // 4xx are usually expected (validation, auth, rate limits) — log the
    // cause without the noisy stack trace.
    console.warn(`[Warning:${now()}] ${method} ${url} [${requestId}] -> ${statusCode}: ${err.message || err}`);
  }

  // Known, safe-to-share error shapes.
  if (err.name === 'ValidationError') {
    const messages = Object.values(err.errors || {}).map(e => e.message);
    return res.status(400).json({ success: false, message: messages.join(', ') });
  }
  if (err.name === 'CastError') {
    return res.status(400).json({ success: false, message: 'Invalid ID format' });
  }
  if (err.code === 11000) {
    return res.status(409).json({ success: false, message: 'Duplicate value entered' });
  }
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }
  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({ success: false, message: 'Token expired' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: 'Invalid request payload' });
  }
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ success: false, message: 'File too large' });
  }
  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({ success: false, message: 'Unexpected file field' });
  }

  const isProduction = process.env.NODE_ENV === 'production';

  const sensitivePatterns = /api[_-]?key|secret|token|password|sk-[a-zA-Z0-9]/i;
  let message = err.message || 'Internal server error';

  if (isProduction) {
    if (statusCode === 500) message = 'Internal server error';
    else if (sensitivePatterns.test(message)) message = 'Request failed';
  }

  res.status(statusCode).json({
    success: false,
    message,
  });
};

export class AppError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}