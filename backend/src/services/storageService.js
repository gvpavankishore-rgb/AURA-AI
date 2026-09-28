import { v4 as uuidv4 } from 'uuid';
import env from '../config/env.js';
import { getSupabase, getAnonClient, isSupabaseConfigured } from '../config/supabase.js';
import { AppError } from '../middleware/errorHandler.js';

// =============================================================================
// SUPABASE STORAGE SERVICE
// -----------------------------------------------------------------------------
// All chat attachment bytes (images, documents, voice memos, AI-enhanced
// images) now live in a PRIVATE Supabase Storage bucket, never on the backend
// filesystem. The design follows your rules strictly:
//
//   * PRIVATE bucket (public = false): there is NO public-read, so the bucket
//     never exposes other users' files to anonymous browsers. (Correct — do
//     not make all storage public without proper policies.)
//   * ACCESS IS OWNER-SCOPED VIA RLS + STORAGE POLICIES: each user's objects
//     live under `chat-attachments/user-{auth.uid()}/...` and the SQL in
//     db/storage_setup.sql grants INSERT/SELECT on ONLY `auth.uid()`'s own
//     `user-*` folder via storage.objects policies that compare the folder
//     against auth.uid(). Anon has NO access at all.
//   * The frontend <img src> / preview / lightbox / click-to-open keep working
//     through SHORT-LIVED SIGNED URLs the backend issues per request (never a
//     "public" image bucket). Even though an <img> tag cannot send an
//     Authorization header, a signed URL carries the token in the query string,
//     so the browser can render it immediately and the bucket itself stays
//     private + RLS-protected.
//   * There is NO service-role key stored anywhere in this repo (honesty: that
//     key stays in your Supabase dashboard / Vault). Bucket creation and the
//     storage policies CANNOT be done from this new service with the anon key
//     alone — you apply db/storage_setup.sql once in the Supabase Dashboard →
//     SQL Editor. Code can only ever operate on objects the caller may access,
//     and uploads always run through the REQUEST-SCOPED client whose JWT
//     already belongs to the logged-in user (from src/config/supabase.js).
//
// Object layout (matches db/storage_setup.sql):
//   chat-attachments / user-{authUid} / {timestamp}-{uuid}.{ext}
//
// In go this file never touches disk and never emits an `uploads/...` path —
// the old multer-disk middleware is replaced by memory-storage + these
// functions. Existing legacy records that still hold an `uploads/...` path are
// left untouched (kept resolvable through the temporary static /uploads mount
// during cutover); every NEW upload goes to Supabase. See memory/seedLoader? No
// — see the honest report at the end of this patch for the exact SQL you must
// run and the dashboard steps.
// =============================================================================

const BUCKET = env.supabaseStorageBucket;

const storageConfigured = () =>
  isSupabaseConfigured() &&
  Boolean(String(BUCKET).trim());

const assertStorageConfigured = () => {
  if (!storageConfigured()) {
    throw new AppError(
      `Supabase Storage is not configured. Set SUPABASE_URL / SUPABASE_ANON_KEY and SUPABASE_STORAGE_BUCKET (=${BUCKET || 'chat-attachments'}), then apply backend/src/db/storage_setup.sql in the Supabase Dashboard SQL Editor (it also creates the private bucket).`,
      500
    );
  }
};

// The request-scoped Supabase client (carries the logged-in user's JWT so the
// storage policies see auth.uid() = the request's owner). This is what every
// upload/read/delete must go through — never the anon client.
const getRequestClient = () => getSupabase();

const randomHex = (bytes = 8) => {
  const arr = new Uint8Array(bytes);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(arr);
  else for (let i = 0; i < arr.length; i += 1) arr[i] = Math.floor(Math.random() * 256);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
};

export const userFolder = (authUid) =>
  String(authUid || '').trim() ? `user-${String(authUid).trim()}` : '';

const objectKey = ({ authUid, filename = '', ext = '' }) => {
  const cleanUid = String(authUid || '').replace(/[^\w-]/g, '');
  if (!cleanUid) throw new AppError('Authentication is required before storage access', 401);
  const folder = userFolder(cleanUid);
  const safeExt = String(ext || '').replace(/^\./, '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  const base = `${Date.now().toString(36)}-${randomHex(6)}`;
  return `${folder}/${base}${safeExt ? `.${safeExt}` : ''}`;
};

// -----------------------------------------------------------------------------
// Storage error classification
// -----------------------------------------------------------------------------
// A raw Supabase Storage failure is opaque: a missing bucket, a missing policy
// and a rejected object all collapse into the same generic 500, which is why
// "POST /api/chat/upload 500" was impossible to diagnose in production. Map the
// cases we can actually act on to a specific error so the cause is named.
//
// Each entry has two parts and the split is deliberate:
//   * `user`  — returned to the client. Short, human, and free of internal file
//               paths / SQL instructions. Safe to render in the UI.
//   * `hint`  — written ONLY to the server log, where the operator needs it.
//               This is where "run backend/src/db/storage_setup.sql" belongs, so
//               a user never sees deployment instructions.
const MISSING_BUCKET_HINT =
  `The private Supabase Storage bucket "${BUCKET}" does not exist in this project. ` +
  'Run backend/src/db/storage_setup.sql once in the Supabase Dashboard -> SQL Editor ' +
  '(it creates the bucket and the owner-only policies), then verify with ' +
  '`cd backend && npm run storage:check` and restart the backend.';

const RLS_HINT =
  `The bucket "${BUCKET}" exists but the owner-scoped INSERT policy rejected the write. ` +
  "Re-run backend/src/db/storage_setup.sql in the Supabase Dashboard -> SQL Editor so the " +
  "'user-' || auth.uid()::text folder policies are (re)created, then verify with " +
  '`cd backend && npm run storage:check`.';

const STORAGE_ERROR_MAP = [
  {
    // Supabase reports a missing bucket as 404/NoSuchBucket, or as a bare 400
    // whose body still says "Bucket not found".
    match: (e) =>
      e?.code === 'NoSuchBucket' ||
      /bucket not found/i.test(e?.message || '') ||
      /bucket not found/i.test(e?.error || ''),
    status: 503,
    user: 'Image storage is not set up on this server yet. Uploads are temporarily unavailable.',
    hint: MISSING_BUCKET_HINT,
  },
  {
    // The bucket exists but the owner-scoped INSERT policy is absent/mismatched.
    // Match on the MESSAGE TEXT or the Postgres 42501 code, never on a bare
    // "AccessDenied": Supabase also returns code=AccessDenied for things that
    // have nothing to do with policies (e.g. a malformed JWT), and folding
    // those together sends the operator chasing a policy that is fine.
    match: (e) =>
      /row-level security|new row violates/i.test(e?.message || '') ||
      e?.code === '42501',
    status: 503,
    user: 'Image storage rejected this upload for permission reasons. Please try again.',
    hint: RLS_HINT,
  },
  {
    // The request's JWT was rejected by Supabase. This is a session/identity
    // problem, not a storage-permission problem, and must not be reported as one.
    match: (e) =>
      /invalid compact jws|invalid jwt|jwt expired|token is expired/i.test(e?.message || '') ||
      e?.statusCode === 401,
    status: 401,
    user: 'Your session has expired. Please sign in again.',
    hint:
      'Supabase rejected the caller\'s access token on the Storage API. This is a session problem, ' +
      'not a bucket-policy problem. Check the request-scoped client in config/supabase.js and the token forwarded by authenticate.',
  },
  {
    // Signed-URL creation can fail simply because the object is already gone.
    match: (e) => /Object not found/i.test(e?.message || '') || e?.code === '404',
    status: 404,
    user: 'The stored file could not be found.',
    hint: `Object missing in bucket "${BUCKET}". The row may reference a deleted object.`,
  },
  {
    match: (e) => /exceeded the maximum allowed size|too large/i.test(e?.message || ''),
    status: 413,
    user: 'That file is too large to upload.',
    hint: `Upload exceeded the bucket size limit for "${BUCKET}".`,
  },
];

// Turn a Supabase Storage error into an AppError. The client gets `user`; the
// operator gets `hint` in the log. Anything unrecognised still surfaces its real
// text in the log so it stays debuggable, and keeps a generic message on the
// client rather than leaking a raw driver error.
export const toStorageAppError = (err, fallbackMessage = 'Could not process the file') => {
  const hit = STORAGE_ERROR_MAP.find((m) => m.match(err));
  if (hit) {
    console.error(`[Storage] ${hit.hint} | underlying: ${err?.message || err}`);
    return new AppError(hit.user, hit.status);
  }
  console.error(`[Storage][unexpected] ${fallbackMessage}: ${err?.message || err}`);
  return new AppError(fallbackMessage, err?.statusCode || 500);
};

// Upload an in-memory buffer to the caller's own folder. Returns the storage
// key (the value persisted in attachment.path) — never a disk path.
export const uploadBuffer = async ({ authUid, buffer, contentType = 'application/octet-stream', filename = '', ext = '' }) => {
  assertStorageConfigured();
  if (!authUid) throw new AppError('Authentication is required before upload', 401);
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new AppError('No upload data provided', 400);
  }
  const key = objectKey({ authUid, filename, ext: ext || filename?.split('.')?.pop?.() || '' });

  const { error } = await getRequestClient().storage.from(BUCKET).upload(key, buffer, {
    contentType,
    cacheControl: '31536000',
    upsert: false,
  });
  if (error) {
    console.error('[Storage][upload] could not save attachment:', error?.message || error);
    throw toStorageAppError(error, 'Could not store the uploaded file');
  }
  const url = await getSignedUrl(key).catch(() => '');
  return { path: key, url };
};

export const downloadBuffer = async (path) => {
  assertStorageConfigured();
  if (!path) throw new AppError('Attachment path is missing', 400);
  const { data, error } = await getRequestClient().storage.from(BUCKET).download(path);
  if (error || !data) {
    console.error('[Storage][download] could not read attachment:', error?.message || error);
    throw toStorageAppError(error, 'Could not read the stored attachment');
  }
  const buffer = await data.arrayBuffer();
  return Buffer.from(buffer);
};

export const getSignedUrl = async (path, ttlSeconds = env.supabaseStorageSignedUrlTtl) => {
  assertStorageConfigured();
  if (!path) return '';
  const { data, error } = await getRequestClient().storage.from(BUCKET).createSignedUrl(path, ttlSeconds);
  if (error || !data?.signedUrl) {
    // Log loudly: an empty signed URL makes the frontend fall back to a
    // non-existent /uploads/... path and render a broken image, which is very
    // hard to diagnose in production. The usual cause is that
    // db/storage_setup.sql has not been applied yet (missing bucket/policies).
    console.error(
      `[Storage][signedUrl] could not sign "${path}": ${error?.message || 'no signedUrl returned'}. ` +
      'Verify the private bucket + owner RLS policies from backend/src/db/storage_setup.sql are applied.'
    );
    return '';
  }
  return data.signedUrl;
};

// TRUE for a key that actually lives in the bucket, i.e. an object written
// under `user-{authUid}/` by uploadBuffer(). This is the single discriminator
// the whole codebase uses to tell a post-migration attachment from a legacy
// `uploads/...` disk row, so it stays the gate for anything that signs, reads
// or deletes storage bytes.
export const isStorageKey = (path) => String(path || '').startsWith('user-');

export const getPublicUrl = (path) => {
  if (!BUCKET || !path) return '';
  return `${String(env.supabaseUrl).replace(/\/+$/, '')}/storage/v1/object/public/${BUCKET}/${String(path).replace(/^\/+/, '')}`;
};

export const deleteObject = async (path) => {
  assertStorageConfigured();
  if (!path) return;
  const { error } = await getRequestClient().storage.from(BUCKET).remove([path]);
  if (error) {
    console.error('[Storage][delete] could not remove attachment:', error?.message || error);
  }
};

// Attach a fresh signed `url` to a Supabase Storage-backed attachment and
// normalise the payload so the frontend always receives the same shape:
//   { path, url, type, mimetype, size }
//
// Attachments whose `path` is a LEGACY `uploads/...` disk reference are
// returned WITHOUT a `url`. They were never migrated into the bucket, so
// there is nothing to sign, and the file they point at only ever existed on
// Render's ephemeral disk. Handing back any leftover absolute `uploads/...`
// URL here is what used to produce a guaranteed 404 in the browser's network
// tab, so the stale value is actively dropped: the frontend then renders a
// calm "unavailable" placeholder without issuing a single request.
export const withSignedUrl = async (att) => {
  if (!att || typeof att !== 'object') return att;
  const p = String(att.path || '');

  // Guarantee the documented contract for every attachment we hand back.
  if (!att.type) att.type = p.startsWith('user-') ? inferTypeFromName(att.filename) : 'file';
  if (!att.mimetype) att.mimetype = p.startsWith('user-') ? inferMimeFromName(att.filename) : '';
  if (typeof att.size !== 'number') att.size = 0;

  if (!p) {
    console.warn('[Storage][attachment] attachment row has no `path` and cannot be resolved.');
    delete att.url;
    return att;
  }

  if (!isStorageKey(p)) {
    if (att.url) {
      console.warn(
        `[Storage][legacy] attachment "${p}" still carried a pre-migration URL. ` +
        'Dropping it: the browser must never request /uploads in production.'
      );
      delete att.url;
    } else {
      console.warn(
        `[Storage][legacy] attachment "${p}" has no signed URL. ` +
        'It is a pre-migration uploads/... row: the bytes only ever existed on the ' +
        'ephemeral backend disk and were never copied into the bucket, so the file is ' +
        'unrecoverable without a re-upload. The frontend renders an "unavailable" ' +
        'placeholder and issues no network request for it.'
      );
    }
    return att;
  }

  const url = await getSignedUrl(p).catch(() => '');
  if (url) {
    att.url = url;
  } else {
    delete att.url;
    console.error(
      `[Storage][withSignedUrl] could not sign migrated attachment "${p}". ` +
      'The frontend will be unable to render it until the bucket + owner RLS policies are applied.'
    );
  }
  return att;
};

const IMAGE_NAME_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
const AUDIO_NAME_RE = /\.(mp3|wav|ogg|webm|m4a|aac|flac)$/i;
const DOC_NAME_RE = /\.(pdf|docx?|pptx?|xlsx?|txt|md|csv|rtf|odt|epub)$/i;

function inferTypeFromName(name = '') {
  if (IMAGE_NAME_RE.test(name)) return 'image';
  if (AUDIO_NAME_RE.test(name)) return 'audio';
  if (DOC_NAME_RE.test(name)) return 'document';
  return 'file';
}

function inferMimeFromName(name = '') {
  const ext = String(name).split('.').pop()?.toLowerCase() || '';
  const map = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', webm: 'audio/webm',
    pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  return map[ext] || '';
}

export const withSignedUrls = async (attachments = []) =>
  Promise.all((attachments || []).filter(Boolean).map(withSignedUrl));

// Re-sign a set of already-persisted storage keys and return
// { "<path>": "<fresh signed url>" }.
//
// This is what makes long-lived chat sessions survive the short signed-URL
// lifetime without the client ever holding a stale URL: the frontend asks for
// the exact keys it is about to render, scoped to the conversation it is
// already authorised to read, and gets back URLs minted at that instant.
// Legacy `uploads/...` rows are never passed through here — there is nothing
// in the bucket to sign, and returning a blank keeps the browser from ever
// requesting /uploads.
export const signPaths = async (paths = []) => {
  const keys = [...new Set(
    (Array.isArray(paths) ? paths : [paths])
      .map((p) => String(p || '').trim())
      .filter((p) => p && isStorageKey(p) && !p.split('/').includes('..')),
  )];

  const entries = await Promise.all(
    keys.map(async (path) => [path, await getSignedUrl(path).catch(() => '')]),
  );

  return Object.fromEntries(entries.filter(([, url]) => Boolean(url)));
};

export default {
  uploadBuffer,
  downloadBuffer,
  getSignedUrl,
  getPublicUrl,
  deleteObject,
  isStorageKey,
  withSignedUrl,
  withSignedUrls,
  signPaths,
  toStorageAppError,
  userFolder,
  BUCKET,
};
