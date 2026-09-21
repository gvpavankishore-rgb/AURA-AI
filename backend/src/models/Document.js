import { SupabaseModel } from './base.js';

const Document = new SupabaseModel('documents', {
  allColumns: ['id', 'user_id', 'filename', 'original_name', 'mime_type', 'size', 'path', 'extracted_text', 'chunks', 'summary', 'created_at', 'updated_at'],
  defaults: { extractedText: '', chunks: [], summary: '' },
});

export default Document;