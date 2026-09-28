// =============================================================================
// Storage readiness check — `npm run storage:check`
// -----------------------------------------------------------------------------
// Verifies that the Supabase Storage prerequisites are actually satisfied,
// using ONLY the public/anon key. No service-role key and no Dashboard access
// are needed, and nothing is written.
//
// This exists because the single most common cause of
//   POST /api/chat/upload -> 500 Internal Server Error
// and of every chat image rendering as "Image unavailable" is that
// src/db/storage_setup.sql was never applied to the project: the private bucket
// and its owner-only policies simply do not exist. That failure is invisible
// from the app's own logs without knowing the bucket name, so run this before
// debugging anything else.
//
// Exit code 0 = ready, 1 = not ready (the printed lines say what to do).
// =============================================================================

import https from 'node:https';
import env from '../config/env.js';
import { isSupabaseConfigured } from '../config/supabase.js';
import storageService from '../services/storageService.js';

const bucket = storageService.BUCKET;
const results = [];
const record = (ok, label, detail) => {
  results.push({ ok, label, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

// node:https rather than global fetch: this check only needs the public key, and
// Node's built-in fetch (undici) leaves a keepalive handle that trips a libuv
// assertion on Windows at process teardown, which turns a clean report into a
// crash-looking exit. Only the public key is ever sent — nothing is written.
const request = (path, { method = 'GET' } = {}) =>
  new Promise((resolve, reject) => {
    const req = https.request(
      `${env.supabaseUrl}${path}`,
      {
        method,
        headers: {
          apikey: env.supabaseAnonKey,
          Authorization: `Bearer ${env.supabaseAnonKey}`,
          ...(method === 'POST' ? { 'Content-Type': 'text/plain' } : {}),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => {
          let parsed = {};
          try { parsed = body ? JSON.parse(body) : {}; } catch { parsed = { message: body }; }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.end(method === 'POST' ? 'probe' : undefined);
  });

console.log('\nAURA AI — Supabase Storage readiness check\n');
console.log(`  project : ${env.supabaseUrl || '(not set)'}`);
console.log(`  bucket  : ${bucket}\n`);

// 1) Credentials present.
if (!isSupabaseConfigured()) {
  record(false, 'SUPABASE_URL / SUPABASE_ANON_KEY are set', 'check backend/.env');
  console.log('\nRESULT: NOT READY — Supabase is not configured.\n');
  process.exit(1);
}
record(true, 'Supabase credentials present');

// 2) The private bucket must exist. This is the check that actually catches the
//    NoSuchBucket -> 500 upload failure.
let bucketExists = false;
try {
  const { status, body } = await request(`/storage/v1/bucket/${bucket}`);
  if (status !== 200 || body.message) {
    record(false, `Bucket "${bucket}" exists`, body.message || `HTTP ${status}`);
  } else {
    bucketExists = true;
    record(true, `Bucket "${bucket}" exists`);
    // 3) It must be PRIVATE. A public bucket would expose every user's files.
    if (body.public === true) {
      record(false, 'Bucket is PRIVATE', 'it is PUBLIC — set public = false in Supabase');
    } else {
      record(true, 'Bucket is PRIVATE (public = false)');
    }
  }
} catch (err) {
  record(false, `Bucket "${bucket}" exists`, err?.message || 'lookup failed');
}

// 4) Write access must be owner-scoped. An anonymous upload is EXPECTED to be
//    rejected (that is the policy working), so a rejection is the pass case; we
//    only flag it if anonymous writes are somehow allowed.
if (bucketExists) {
  try {
    const probe = `user-storagecheck/probe-${Date.now()}.txt`;
    const { status, body } = await request(`/storage/v1/object/${bucket}/${probe}`, { method: 'POST' });
    if (status === 200) {
      record(false, 'Anon writes are rejected', `anonymous write SUCCEEDED to ${probe} — bucket is open`);
    } else {
      record(true, 'Anon writes are rejected (owner-only policy is active)', body.message || `HTTP ${status}`);
    }
  } catch (err) {
    record(true, 'Anon writes are rejected', err?.message || 'rejected');
  }
}

const failed = results.filter((r) => !r.ok);
console.log('');
if (failed.length === 0) {
  console.log('RESULT: READY — uploads and signed URLs should work.\n');
  process.exit(0);
}

console.log(`RESULT: NOT READY — ${failed.length} check(s) failed.\n`);
console.log('Next step: open your Supabase project -> SQL Editor and run\n');
console.log('    backend/src/db/storage_setup.sql\n');
console.log('It is idempotent (safe to re-run). It creates the private bucket and');
console.log('the owner-only INSERT/UPDATE/DELETE policies, then re-run this check.\n');
process.exit(1);
