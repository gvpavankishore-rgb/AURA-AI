import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { Menu, ArrowLeftRight, Copy } from 'lucide-react';
import api from '../services/api';

const languages = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'it', name: 'Italian' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'ru', name: 'Russian' },
  { code: 'zh', name: 'Chinese' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'ar', name: 'Arabic' },
  { code: 'hi', name: 'Hindi' },
  { code: 'te', name: 'Telugu', nativeName: 'తెలుగు' },
  { code: 'tr', name: 'Turkish' },
  { code: 'nl', name: 'Dutch' },
  { code: 'sv', name: 'Swedish' },
  { code: 'pl', name: 'Polish' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'th', name: 'Thai' },
  { code: 'id', name: 'Indonesian' },
];

const languageLabel = l => (l.nativeName ? `${l.name} (${l.nativeName})` : l.name);

export default function TranslatePage() {
  const { onMenuClick } = useOutletContext();
  const [sourceLang, setSourceLang] = useState('en');
  const [targetLang, setTargetLang] = useState('es');
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [loading, setLoading] = useState(false);

  const handleTranslate = async () => {
    if (!input.trim()) return;
    setLoading(true);
    try {
      const src = languages.find(l => l.code === sourceLang);
      const tgt = languages.find(l => l.code === targetLang);
      const res = await api.translate({
        text: input,
        sourceLanguage: src?.name,
        targetLanguage: tgt?.name,
        sourceCode: sourceLang || undefined,
        targetCode: targetLang,
      });
      if (res.success) setOutput(res.data.translation);
    } catch (err) {
      setOutput('Translation error');
    }
    setLoading(false);
  };

  const handleSwap = () => {
    setSourceLang(targetLang);
    setTargetLang(sourceLang || 'en');
    setInput(output);
    setOutput(input);
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(output);
  };

  return (
    <>
      <div className="topbar">
        <button className="menu-btn btn-ghost" onClick={onMenuClick}><Menu size={20} /></button>
        <div className="topbar-title">Translate</div>
      </div>

      <div className="feature-page">
        <div className="feature-card">
          <h2>Translate Text</h2>

          <div className="translate-lang-row">
            <select value={sourceLang} onChange={e => setSourceLang(e.target.value)} aria-label="Source language">
              <option value="">Auto Detect</option>
              {languages.map(l => <option key={l.code} value={l.code}>{languageLabel(l)}</option>)}
            </select>
            <button className="swap-btn" onClick={handleSwap}><ArrowLeftRight size={16} /></button>
            <select value={targetLang} onChange={e => setTargetLang(e.target.value)} aria-label="Target language">
              {languages.map(l => <option key={l.code} value={l.code}>{languageLabel(l)}</option>)}
            </select>
          </div>

          <div className="translate-panel">
            <div className="translate-col">
              <textarea
                value={input}
                onChange={e => setInput(e.target.value)}
                placeholder="Enter text to translate..."
              />
            </div>
            <div className="translate-col">
              <textarea
                value={output}
                readOnly
                placeholder="Translation will appear here..."
                style={{ background: 'var(--bg-primary)' }}
              />
              {output && (
                <button className="btn btn-secondary btn-sm" onClick={handleCopy} style={{ marginTop: '8px' }}>
                  <Copy size={12} /> Copy
                </button>
              )}
            </div>
          </div>

          <button className="btn btn-primary" onClick={handleTranslate} disabled={loading || !input.trim()} style={{ marginTop: '16px' }}>
            {loading ? 'Translating...' : 'Translate'}
          </button>
        </div>
      </div>
    </>
  );
}
