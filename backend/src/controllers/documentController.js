import Document from '../models/Document.js';
import { AppError } from '../middleware/errorHandler.js';
import { success, created } from '../utils/response.js';
import { processMessage } from '../services/aiService.js';
import { extractTextFromBuffer } from '../services/documentText.js';
import * as storageService from '../services/storageService.js';

const chunkText = (text, chunkSize = 2000) => {
  const chunks = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks;
};

const authUidOf = (req) => req.authUserId || req.user?._id?.toString() || '';

export const uploadDocument = async (req, res, next) => {
  try {
    if (!req.user) throw new AppError('Authentication required', 401);
    if (!req.file?.buffer) throw new AppError('No file uploaded', 400);

    const { buffer, originalname, mimetype, size } = req.file;

    // Text extraction runs straight off the in-memory bytes; the original file
    // is persisted to the PRIVATE Supabase Storage bucket (owner-scoped) and
    // only its storage key is stored in Mongo — never a disk path.
    const extractedText = await extractTextFromBuffer(buffer, originalname);
    const chunks = chunkText(extractedText);

    const uploaded = await storageService.uploadBuffer({
      authUid: authUidOf(req),
      buffer,
      contentType: mimetype,
      filename: originalname,
    });

    const doc = await Document.create({
      user: req.user._id,
      filename: uploaded.path,
      originalName: originalname,
      mimeType: mimetype,
      size,
      path: uploaded.path,
      extractedText,
      chunks,
    });

    created(res, {
      id: doc._id,
      filename: doc.originalName,
      size: doc.size,
      mimeType: doc.mimeType,
      path: doc.path,
      url: uploaded.url,
      textLength: extractedText.length,
      chunks: chunks.length,
    });
  } catch (err) {
    next(err);
  }
};

export const getDocuments = async (req, res, next) => {
  try {
    const docs = await Document.find({ user: req.user._id })
      .sort({ createdAt: -1 })
      .select('originalName mimeType size createdAt path');
    // Attach a fresh short-lived signed URL per document so the client can
    // link/open the file without the bucket ever being public.
    for (const doc of docs) {
      doc.url = await storageService.getSignedUrl(doc.path).catch(() => '');
    }
    success(res, docs);
  } catch (err) {
    next(err);
  }
};

export const getDocument = async (req, res, next) => {
  try {
    const doc = await Document.findOne({ _id: req.params.id, user: req.user._id });
    if (!doc) throw new AppError('Document not found', 404);
    const url = await storageService.getSignedUrl(doc.path).catch(() => '');
    success(res, {
      id: doc._id,
      filename: doc.originalName,
      mimeType: doc.mimeType,
      size: doc.size,
      createdAt: doc.createdAt,
      path: doc.path,
      url,
      textPreview: doc.extractedText.slice(0, 1000),
      chunks: doc.chunks.length,
    });
  } catch (err) {
    next(err);
  }
};

export const deleteDocument = async (req, res, next) => {
  try {
    const doc = await Document.findOneAndDelete({ _id: req.params.id, user: req.user._id });
    if (!doc) throw new AppError('Document not found', 404);
    // Remove the object from Supabase Storage (owner-scoped by RLS). Legacy
    // rows that still hold a disk `uploads/...` path are skipped here.
    if (doc.path && String(doc.path).startsWith('user-')) {
      await storageService.deleteObject(doc.path);
    }
    success(res, null, 'Document deleted');
  } catch (err) {
    next(err);
  }
};

export const askDocument = async (req, res, next) => {
  try {
    const { question } = req.body;
    if (!question) throw new AppError('Question is required', 400);

    const doc = await Document.findOne({ _id: req.params.id, user: req.user._id });
    if (!doc) throw new AppError('Document not found', 404);

    const relevantChunks = doc.chunks.slice(0, 5);
    const context = relevantChunks.join('\n\n---\n\n');

    const response = await processMessage({
      messages: [
        { role: 'system', content: `You are analyzing a document named "${doc.originalName}". Answer questions based on the document content below.\n\nDocument content:\n${context}` },
        { role: 'user', content: question },
      ],
      mode: 'documents',
    });

    success(res, { answer: response.content, documentName: doc.originalName });
  } catch (err) {
    next(err);
  }
};

export const summarizeDocument = async (req, res, next) => {
  try {
    const doc = await Document.findOne({ _id: req.params.id, user: req.user._id });
    if (!doc) throw new AppError('Document not found', 404);

    const context = doc.chunks.slice(0, 5).join('\n\n---\n\n');

    const response = await processMessage({
      messages: [
        { role: 'system', content: `You are summarizing a document named "${doc.originalName}". Provide a comprehensive summary.\n\nDocument content:\n${context}` },
        { role: 'user', content: 'Please summarize this document.' },
      ],
      mode: 'documents',
    });

    success(res, { summary: response.content, documentName: doc.originalName });
  } catch (err) {
    next(err);
  }
};
