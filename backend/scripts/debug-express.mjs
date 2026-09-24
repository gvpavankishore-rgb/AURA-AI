import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

const app = express();

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: ['http://localhost:5173'], credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 600, message: { success: false, message: 'Too many requests.' } }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.post('/api/echo', (req, res) => {
  res.json({ ok: true, body: req.body });
});

app.use('/api', (req, res, next) => next(Object.assign(new Error('Not found'), { status: 404 })));
app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ success: false, message: err.message });
});

app.listen(5999, () => console.log('TEST SERVER on 5999'));