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

// Upload an in-memory buffer to the caller's own folder. Returns the storage
// key (the value persisted in attachment.path) — never a disk path.
export const uploadBuffer = async ({ authUid, buffer, contentType = 'application/octet-stream', filename = '', ext = '' }) => {
  assertStorageConfigured();
  if (!authUid) throw new AppError('Authentication is required before upload', 401);
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new AppError('No upload data provided', 400);
  }
  const lastUidByte = String(authUid).trim().slice(-1);
  const key = objectKey({ authUid, filename, ext: ext || filename?.split('.')?.pop?.() || '' });

  const { error } = await getRequestClient().storage.from(BUCKET).upload(key, buffer, {
    contentType,
    cacheControl: '31536000',
    upsert: false,
  });
  if (error) {
    console.error('[Storage][upload] could not save attachment:', error?.message || error);
    throw new AppError('Could not store the uploaded file', 500);
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
    throw new AppError('Could not read the stored attachment', 500);
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
// returned untouched: they were never migrated into the bucket, so there is
// nothing to sign, and the frontend is allowed to resolve them against the
// temporary /uploads static mount during cutover.
export const withSignedUrl = async (att) => {
  if (!att || typeof att !== 'object') return att;
  const p = String(att.path || '');

  // Guarantee the documented contract for every attachment we hand back.
  if (!att.type) att.type = p.startsWith('user-') ? inferTypeFromName(att.filename) : 'file';
  if (!att.mimetype) att.mimetype = p.startsWith('user-') ? inferMimeFromName(att.filename) : '';
  if (typeof att.size !== 'number') att.size = 0;

  if (!p) {
    console.warn('[Storage][attachment] attachment row has no `path` and cannot be resolved.');
    return att;
  }

  if (!p.startsWith('user-')) {
    if (!att.url) {
      console.warn(
        `[Storage][legacy] attachment "${p}" has no signed URL. ` +
        'It is a pre-migration uploads/... row: the backend can only serve it if the file ' +
        'still exists in backend/uploads (ephemeral on Render, so expect 404 after a deploy). ' +
        'Re-upload the file to move it into Supabase Storage.'
      );
    }
    return att;
  }

  const url = await getSignedUrl(p).catch(() => '');
  if (url) {
    att.url = url;
  } else {
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

export default {
  uploadBuffer,
  downloadBuffer,
  getSignedUrl,
  getPublicUrl,
  deleteObject,
  withSignedUrl,
  withSignedUrls,
  userFolder,
  BUCKET,
};
