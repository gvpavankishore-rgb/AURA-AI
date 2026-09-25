// Extract plain text from an attachment's BYTES. Callers pull the bytes from
// Supabase Storage (storageService.downloadBuffer) and pass the buffer here —
// this module itself never touches a disk path, never reads `uploads/...`, and
// never uses `fs.readFileSync(path)`. Supported: txt/md (utf-8), PDF
// (pdf-parse), DOCX (mammoth raw text).
const extractExtension = (name) => {
  const base = String(name || '');
  const ext = base.includes('.') ? '.' + base.split('.').pop().toLowerCase() : '';
  if (['.txt', '.md', '.pdf', '.docx'].includes(ext)) return ext;
  return '';
};

export const extractTextFromBuffer = async (buffer, originalName = '') => {
  const ext = extractExtension(originalName);
  if (ext === '.txt' || ext === '.md') {
    return Buffer.isBuffer(buffer) ? buffer.toString('utf-8') : String(buffer || '');
  }
  if (ext === '.pdf') {
    const pdfParse = (await import('pdf-parse')).default;
    const data = await pdfParse(buffer);
    return data.text;
  }
  if (ext === '.docx') {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  return '';
};
