# AURA AI

A production-ready multimodal AI assistant web application with chat, voice, images, documents, coding, translation, and memory features.

## Tech Stack

**Frontend:** React 18, Vite, React Router, React Markdown, Lucide Icons  
**Backend:** Node.js, Express.js, Supabase (PostgreSQL), external AI provider (OpenAI-compatible)  
**Auth:** JWT (access + refresh tokens), bcryptjs  
**Security:** Helmet, CORS, rate limiting, input validation

## Project Structure

```
AURA-AI/
├── frontend/          # React + Vite
├── backend/           # Express + Supabase
├── .env.example
└── README.md
```

## Installation

### Backend

```bash
cd backend
npm install
cp ../.env.example .env  # Edit with your values
npm run dev
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

## Environment Variables

Copy `.env.example` to `backend/.env` and configure:

| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_ANON_KEY` | Supabase anon key (backend-only) |
| `JWT_SECRET` | Secret for access tokens |
| `JWT_REFRESH_SECRET` | Secret for refresh tokens |
| `AI_PROVIDER` | AI provider name (default: openai) |
| `AI_API_KEY` | AI provider API key (server-only) |
| `AI_MODEL` | Chat model (default: gpt-4o) |
| `AI_BASE_URL` | OpenAI-compatible API base URL (default: https://api.openai.com/v1) |
| `CLIENT_URL` | Frontend URL (default: http://localhost:5173) |

Before first run, apply the Supabase schema in `backend/src/db/schema.sql` via the Supabase SQL editor.

## Development Commands

```bash
# Backend
cd backend && npm run dev

# Frontend
cd frontend && npm run dev
```

## Features

- **Chat:** Unified AI chat with markdown, code highlighting, streaming
- **Voice:** Speech-to-text and text-to-speech
- **Images:** Image analysis and enhancement
- **Documents:** PDF/DOCX/TXT upload, Q&A, summarization
- **Coding:** Code generation, explanation, debugging, optimization
- **Translation:** Multi-language translation (20+ languages)
- **Memory:** User-controlled AI memory
- **Auth:** Register, login, JWT auth, password management
- **Settings:** Theme, voice, chat preferences
- **Responsive:** Desktop, tablet, mobile support

## Production Build

```bash
cd frontend && npm run build
```

## Security Notes

- API keys are never exposed to the frontend
- All secrets via environment variables
- JWT-based authentication with refresh tokens
- Rate limiting on API endpoints
- File upload validation and size limits
- Helmet security headers
- CORS configured for frontend origin only
