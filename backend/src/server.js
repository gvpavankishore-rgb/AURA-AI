import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import env, { validateEnv } from './config/env.js';
import userRoutes from './routes/users.js';
import chatRoutes from './routes/chat.js';
import documentRoutes from './routes/documents.js';
import imageRoutes from './routes/images.js';
import voiceRoutes from './routes/voice.js';
import translateRoutes from './routes/translate.js';
import memoryRoutes from './routes/memory.js';
import settingsRoutes from './routes/settings.js';
import { errorHandler, AppError } from './middleware/errorHandler.js';
import { globalLimiter } from './middleware/rateLimiters.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

process.on('uncaughtException', (err) => {
  console.error(`[FATAL] Uncaught Exception`, err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled Promise Rejection', reason);
});

const app = express();
app.disable('x-powered-by');

// Security headers. contentSecurityPolicy is disabled because the frontend
// is a standalone SPA (built separately) that already sets its own CSP at
// the hosting layer; crossOriginEmbedderPolicy is off to avoid blocking
// cross-origin media from OpenRouter / Supabase storage.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  origin: env.clientOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use('/api/', globalLimiter);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

app.use('/api/users', userRoutes);
app.use('/api/chats', chatRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/images', imageRoutes);
app.use('/api/voice', voiceRoutes);
app.use('/api/translate', translateRoutes);
app.use('/api/memory', memoryRoutes);
app.use('/api/settings', settingsRoutes);

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'AURA AI is running',
    aiProvider: env.aiProvider,
    model: env.aiModel,
    database: 'supabase',
  });
});

// Unknown API paths -> structured 404 instead of the HTML fallback.
app.use('/api', (req, res, next) => {
  next(new AppError('Not found', 404));
});

app.use(errorHandler);

const start = async () => {
  try {
    validateEnv();
    app.listen(env.port, () => {
      console.log(`\n  AURA AI server running on port ${env.port} [${env.nodeEnv}]`);
      console.log(`  AI service: ${env.aiProvider} (${env.aiModel})${env.hasAiKey ? '' : ' [missing OPENROUTER_API_KEY]'}`);
      console.log(`  Database: Supabase${env.hasSupabase ? '' : ' [missing SUPABASE_URL / SUPABASE_ANON_KEY]'}`);
      console.log('');
    });
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }
};

start();

export default app;