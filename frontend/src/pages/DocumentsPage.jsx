import { useState, useEffect } from 'react';
import { useOutletContext } from 'react-router-dom';
import { Menu, FileText, Trash2, MessageSquare, BookOpen } from 'lucide-react';
import api from '../services/api';
import ReactMarkdown from 'react-markdown';
import { FeaturePageSkeleton } from '../components/Skeleton';

export default function DocumentsPage() {
  const { onMenuClick } = useOutletContext();
  const [documents, setDocuments] = useState([]);
  const [documentsLoading, setDocumentsLoading] = useState(true);
  const [selectedDoc, setSelectedDoc] = useState(null);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);

  useEffect(() => { loadDocuments(); }, []);

  const loadDocuments = async () => {
    setDocumentsLoading(true);
    try {
      const res = await api.getDocuments();
      if (res.success) setDocuments(res.data);
    } finally {
      setDocumentsLoading(false);
    }
  };

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      await api.uploadDocument(file);
      loadDocuments();
    } catch (err) {
      alert('Upload failed');
    }
    setUploading(false);
    e.target.value = '';
  };

  const handleDelete = async (id) => {
    await api.deleteDocument(id);
    if (selectedDoc?._id === id) setSelectedDoc(null);
    loadDocuments();
  };

  const handleAsk = async () => {
    if (!question.trim() || !selectedDoc) return;
    setLoading(true);
    setAnswer('');
    try {
      const res = await api.askDocument(selectedDoc._id, question);
      if (res.success) setAnswer(res.data.answer);
    } catch (err) {
      setAnswer('Error getting answer');
    }
    setLoading(false);
  };

  const handleSummarize = async () => {
    if (!selectedDoc) return;
    setLoading(true);
    setAnswer('');
    try {
      const res = await api.summarizeDocument(selectedDoc._id);
      if (res.success) setAnswer(res.data.summary);
    } catch (err) {
      setAnswer('Error summarizing document');
    }
    setLoading(false);
  };

  const formatSize = (bytes) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  };

  return (
    <>
      <div className="topbar">
        <button className="menu-btn btn-ghost" onClick={onMenuClick}><Menu size={20} /></button>
        <div className="topbar-title">Document AI</div>
      </div>

      <div className="feature-page">
        {documentsLoading ? (
          <FeaturePageSkeleton cards={2} />
        ) : (
          <>
            <div className="feature-card">
              <h2>Upload Document</h2>
              <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginBottom: '12px' }}>
                Supports PDF, DOCX, TXT, and Markdown files.
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <input type="file" accept=".pdf,.docx,.txt,.md" onChange={handleUpload} />
                {uploading && <div className="loader" />}
              </div>
            </div>

        {documents.length > 0 && (
          <div className="feature-card">
            <h2>Your Documents</h2>
            <div className="doc-list">
              {documents.map(doc => (
                <div
                  key={doc._id}
                  className={`doc-item ${selectedDoc?._id === doc._id ? 'active' : ''}`}
                  onClick={() => setSelectedDoc(doc)}
                  style={{ cursor: 'pointer', borderColor: selectedDoc?._id === doc._id ? 'var(--accent)' : undefined }}
                >
                  <div className="doc-icon"><FileText size={18} /></div>
                  <div className="doc-info">
                    <div className="doc-name">{doc.originalName}</div>
                    <div className="doc-meta">{formatSize(doc.size)} · {new Date(doc.createdAt).toLocaleDateString()}</div>
                  </div>
                  <button className="btn-ghost" onClick={e => { e.stopPropagation(); handleDelete(doc._id); }}>
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {selectedDoc && (
          <div className="feature-card">
            <h2>Ask about: {selectedDoc.originalName}</h2>
            <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
              <input
                value={question}
                onChange={e => setQuestion(e.target.value)}
                placeholder="Ask a question about this document..."
                onKeyDown={e => e.key === 'Enter' && handleAsk()}
                style={{ flex: 1 }}
              />
              <button className="btn btn-primary btn-sm" onClick={handleAsk} disabled={loading || !question.trim()}>
                <MessageSquare size={14} /> Ask
              </button>
              <button className="btn btn-secondary btn-sm" onClick={handleSummarize} disabled={loading}>
                <BookOpen size={14} /> Summarize
              </button>
            </div>

            {loading && <div className="loader" style={{ margin: '20px auto' }} />}

            {answer && (
              <div className="feature-card" style={{ background: 'var(--bg-tertiary)', marginTop: '12px' }}>
                <div className="message-content" style={{ fontSize: '14px' }}>
                  <ReactMarkdown>{answer}</ReactMarkdown>
                </div>
              </div>
            )}
          </div>
        )}
        </>
        )}
      </div>
    </>
  );
}
