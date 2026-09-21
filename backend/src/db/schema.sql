-- =====================================================================
-- AURA AI - Supabase schema
-- Run this in the Supabase SQL editor (or via `supabase db push`) BEFORE
-- starting the backend. It replaces the old MongoDB collections.
--
-- Tables: users, conversations, messages, documents, memories,
--         refresh_tokens, user_settings
-- =====================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------
create table if not exists public.users (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null,
  email                 text not null unique,
  password_hash         text not null default '',
  avatar                text not null default '',
  memory_enabled        boolean not null default true,
  password_reset_token  text default null,
  password_reset_expires timestamptz default null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- conversations (chat history)
-- ---------------------------------------------------------------------
create table if not exists public.conversations (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users (id) on delete cascade,
  title      text not null default 'New Chat',
  pinned     boolean not null default false,
  archived   boolean not null default false,
  mode       text not null default 'chat',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- messages
-- ---------------------------------------------------------------------
create table if not exists public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  role            text not null,
  content         text not null,
  attachments     jsonb not null default '[]',
  metadata        jsonb not null default '{}',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- documents (uploaded files metadata + extracted text)
-- ---------------------------------------------------------------------
create table if not exists public.documents (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.users (id) on delete cascade,
  filename       text not null,
  original_name  text not null,
  mime_type      text not null,
  size           bigint not null,
  path           text not null,
  extracted_text text not null default '',
  chunks         jsonb not null default '[]',
  summary        text not null default '',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- memories
-- ---------------------------------------------------------------------
create table if not exists public.memories (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users (id) on delete cascade,
  content    text not null,
  type       text not null default 'custom',
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- refresh_tokens (user sessions)
-- ---------------------------------------------------------------------
create table if not exists public.refresh_tokens (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users (id) on delete cascade,
  token      text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- user_settings
-- ---------------------------------------------------------------------
create table if not exists public.user_settings (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null unique references public.users (id) on delete cascade,
  theme             text not null default 'dark',
  language          text not null default 'en',
  voice_id          text not null default 'alloy',
  voice_speed       numeric not null default 1,
  auto_play_voice   boolean not null default false,
  enter_to_send     boolean not null default true,
  show_timestamps   boolean not null default true,
  streaming_enabled boolean not null default true,
  memory_enabled    boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------
create index if not exists idx_conversations_user
  on public.conversations (user_id, updated_at desc);
create index if not exists idx_messages_conversation
  on public.messages (conversation_id, created_at asc);
create index if not exists idx_documents_user
  on public.documents (user_id, created_at desc);
create index if not exists idx_memories_user
  on public.memories (user_id, created_at desc);
create index if not exists idx_refresh_tokens_token
  on public.refresh_tokens (token);
create index if not exists idx_refresh_tokens_expires
  on public.refresh_tokens (expires_at);
create index if not exists idx_user_settings_user
  on public.user_settings (user_id);

-- ---------------------------------------------------------------------
-- Row Level Security
-- Only the backend uses these tables (keys are server-side only).
-- RLS is enabled with a permissive policy for the anon role so the
-- backend's anon key can read/write all rows.
-- ---------------------------------------------------------------------
alter table public.users enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.documents enable row level security;
alter table public.memories enable row level security;
alter table public.refresh_tokens enable row level security;
alter table public.user_settings enable row level security;

create policy "aura_server_access_users" on public.users for all to anon using (true) with check (true);
create policy "aura_server_access_conversations" on public.conversations for all to anon using (true) with check (true);
create policy "aura_server_access_messages" on public.messages for all to anon using (true) with check (true);
create policy "aura_server_access_documents" on public.documents for all to anon using (true) with check (true);
create policy "aura_server_access_memories" on public.memories for all to anon using (true) with check (true);
create policy "aura_server_access_refresh_tokens" on public.refresh_tokens for all to anon using (true) with check (true);
create policy "aura_server_access_user_settings" on public.user_settings for all to anon using (true) with check (true);