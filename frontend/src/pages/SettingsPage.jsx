import { useState, useEffect } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useTheme } from '../context/ThemeContext';
import { Menu, Trash2 } from 'lucide-react';
import api from '../services/api';
import { FeaturePageSkeleton } from '../components/Skeleton';

export default function SettingsPage() {
  const { onMenuClick } = useOutletContext();
  const { theme, setTheme } = useTheme();
  const [settings, setSettings] = useState(null);
  const [message, setMessage] = useState('');
  const [memories, setMemories] = useState([]);

  useEffect(() => {
    loadSettings();
    loadMemories();
  }, []);

  const loadSettings = async () => {
    const res = await api.getSettings();
    if (res.success) setSettings(res.data);
  };

  const loadMemories = async () => {
    const res = await api.getMemories();
    if (res.success) setMemories(res.data);
  };

  const updateSetting = async (key, value) => {
    const res = await api.updateSettings({ [key]: value });
    if (res.success) {
      setSettings(res.data);
      if (key === 'theme') setTheme(value);
    }
  };

  const handleClearHistory = async () => {
    if (confirm('Delete all conversations? This cannot be undone.')) {
      await api.deleteAllChats();
      setMessage('All conversations deleted');
    }
  };

  const handleClearMemories = async () => {
    if (confirm('Clear all memories?')) {
      await api.clearMemories();
      setMemories([]);
      setMessage('Memories cleared');
    }
  };

  const handleDeleteMemory = async (id) => {
    await api.deleteMemory(id);
    setMemories(prev => prev.filter(m => m._id !== id));
  };

  if (!settings) return <FeaturePageSkeleton cards={3} />;

  return (
    <>
      <div className="topbar">
        <button className="menu-btn btn-ghost" onClick={onMenuClick}><Menu size={20} /></button>
        <div className="topbar-title">Settings</div>
      </div>

      <div className="feature-page">
        {message && (
          <div style={{
            padding: '12px 16px',
            background: 'rgba(34,197,94,0.1)',
            color: 'var(--success)',
            borderRadius: 'var(--radius-sm)',
            fontSize: '14px',
            marginBottom: '20px',
          }}>
            {message}
          </div>
        )}

        <div className="settings-section">
          <h2>Appearance</h2>
          <div className="settings-row">
            <div>
              <label>Theme</label>
              <div className="setting-desc">Choose your preferred theme</div>
            </div>
            <select value={theme} onChange={e => { setTheme(e.target.value); updateSetting('theme', e.target.value); }}
              style={{ width: '140px' }}>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
              <option value="system">System</option>
            </select>
          </div>
        </div>

        <div className="settings-section">
          <h2>Chat</h2>
          <div className="settings-row">
            <div>
              <label>Enter to send</label>
              <div className="setting-desc">Press Enter to send messages</div>
            </div>
            <label className="toggle">
              <input type="checkbox" checked={settings.enterToSend} onChange={e => updateSetting('enterToSend', e.target.checked)} />
              <span className="slider" />
            </label>
          </div>
          <div className="settings-row">
            <div>
              <label>Show timestamps</label>
              <div className="setting-desc">Display message timestamps</div>
            </div>
            <label className="toggle">
              <input type="checkbox" checked={settings.showTimestamps} onChange={e => updateSetting('showTimestamps', e.target.checked)} />
              <span className="slider" />
            </label>
          </div>
          <div className="settings-row">
            <div>
              <label>Streaming</label>
              <div className="setting-desc">Show responses as they are generated</div>
            </div>
            <label className="toggle">
              <input type="checkbox" checked={settings.streamingEnabled} onChange={e => updateSetting('streamingEnabled', e.target.checked)} />
              <span className="slider" />
            </label>
          </div>
        </div>

        <div className="settings-section">
          <h2>Voice</h2>
          <div className="settings-row">
            <div>
              <label>Voice</label>
              <div className="setting-desc">Select AI voice</div>
            </div>
            <select value={settings.voiceId} onChange={e => updateSetting('voiceId', e.target.value)} style={{ width: '140px' }}>
              <option value="alloy">Alloy</option>
              <option value="echo">Echo</option>
              <option value="fable">Fable</option>
              <option value="onyx">Onyx</option>
              <option value="nova">Nova</option>
              <option value="shimmer">Shimmer</option>
            </select>
          </div>
          <div className="settings-row">
            <div>
              <label>Speed</label>
              <div className="setting-desc">Voice speaking speed</div>
            </div>
            <input
              type="range"
              min="0.25"
              max="4"
              step="0.25"
              value={settings.voiceSpeed}
              onChange={e => updateSetting('voiceSpeed', parseFloat(e.target.value))}
              style={{ width: '140px' }}
            />
          </div>
        </div>

        <div className="settings-section">
          <h2>Memory</h2>
          <div className="settings-row">
            <div>
              <label>Enable memory</label>
              <div className="setting-desc">AURA remembers your preferences</div>
            </div>
            <label className="toggle">
              <input type="checkbox" checked={settings.memoryEnabled} onChange={e => updateSetting('memoryEnabled', e.target.checked)} />
              <span className="slider" />
            </label>
          </div>

          {memories.length > 0 && (
            <div style={{ marginTop: '12px' }}>
              <div className="doc-list">
                {memories.map(m => (
                  <div key={m._id} className="doc-item">
                    <div className="doc-info">
                      <div className="doc-name">{m.content}</div>
                      <div className="doc-meta">{m.type} · {new Date(m.createdAt).toLocaleDateString()}</div>
                    </div>
                    <button className="btn-ghost" onClick={() => handleDeleteMemory(m._id)}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
              <button className="btn btn-danger btn-sm" onClick={handleClearMemories} style={{ marginTop: '12px' }}>
                Clear All Memories
              </button>
            </div>
          )}
        </div>

        <div className="settings-section">
          <h2>Privacy</h2>
          <div className="settings-row">
            <div>
              <label>Clear all conversations</label>
              <div className="setting-desc">Delete all chat history permanently</div>
            </div>
            <button className="btn btn-danger btn-sm" onClick={handleClearHistory}>
              <Trash2 size={14} /> Clear History
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
