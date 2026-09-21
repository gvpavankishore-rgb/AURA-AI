import Document from '../models/Document.js';
import fs from 'fs';
import { AppError } from '../middleware/errorHandler.js';
import { success, created } from '../utils/response.js';
import { processMessage } from '../services/aiService.js';
import { extractTextFromFile } from '../services/documentText.js';

const chunkText = (text, chunkSize = 2000) => {
  const chunks = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks;
};

export const uploadDocument = async (req, res, next) => {
  try {
    if (!req.file) throw new AppError('No file uploaded', 400);

    const extractedText = await extractTextFromFile(req.file.path, req.file.originalname);
    const chunks = chunkText(extractedText);

    const doc = await Document.create({
      user: req.user._id,
      filename: req.file.filename,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      path: req.file.path,
      extractedText,
      chunks,
    });

    created(res, {
      id: doc._id,
      filename: doc.originalName,
      size: doc.size,
      mimeType: doc.mimeType,
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
      .select('originalName mimeType size createdAt');
    success(res, docs);
  } catch (err) {
    next(err);
  }
};

export const getDocument = async (req, res, next) => {
  try {
    const doc = await Document.findOne({ _id: req.params.id, user: req.user._id });
    if (!doc) throw new AppError('Document not found', 404);
    success(res, {
      id: doc._id,
      filename: doc.originalName,
      mimeType: doc.mimeType,
      size: doc.size,
      createdAt: doc.createdAt,
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
    if (fs.existsSync(doc.path)) fs.unlinkSync(doc.path);
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
