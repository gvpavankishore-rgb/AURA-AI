import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Menu } from 'lucide-react';
import api from '../services/api';
import { supabase } from '../lib/supabase';

export default function ProfilePage() {
  const { onMenuClick } = useOutletContext();
  const { user, updateUser, logout } = useAuth();
  const [name, setName] = useState(user?.name || '');
  const [newPassword, setNewPassword] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  const handleUpdateName = async () => {
    if (!name.trim()) return;
    setLoading(true);
    const res = await api.updateMe({ name });
    if (res.success) {
      await supabase.auth.updateUser({ data: { full_name: name.trim() } }).catch(() => {});
      updateUser(res.data);
      setMessage('Profile updated');
    }
    setLoading(false);
  };

  const handleChangePassword = async () => {
    if (!newPassword) return;
    if (newPassword.length < 6) { setMessage('Password must be at least 6 characters'); return; }
    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    setLoading(false);
    if (!error) {
      setMessage('Password changed successfully');
      setNewPassword('');
    } else {
      setMessage(error.message || 'Password change failed');
    }
  };

  const handleDeleteAccount = async () => {
    await api.deleteAccount();
    logout();
  };

  const initial = user?.name?.[0]?.toUpperCase() || 'U';

  return (
    <>
      <div className="topbar">
        <button className="menu-btn btn-ghost" onClick={onMenuClick}><Menu size={20} /></button>
        <div className="topbar-title">Profile</div>
      </div>

      <div className="profile-page">
        <div className="profile-avatar-section">
          <div className="profile-avatar">{initial}</div>
          <div>
            <h2 style={{ fontSize: '20px', fontWeight: 600 }}>{user?.name}</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>{user?.email}</p>
          </div>
        </div>

        {message && (
          <div style={{
            padding: '12px 16px',
            background: message.includes('Error') || message.includes('incorrect') ? 'rgba(239,68,68,0.1)' : 'rgba(34,197,94,0.1)',
            color: message.includes('Error') || message.includes('incorrect') ? 'var(--danger)' : 'var(--success)',
            borderRadius: 'var(--radius-sm)',
            fontSize: '14px',
            marginBottom: '20px',
          }}>
            {message}
          </div>
        )}

        <div className="settings-section">
          <h2>Account Information</h2>
          <div className="form-group">
            <label>Name</label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input value={name} onChange={e => setName(e.target.value)} />
              <button className="btn btn-primary btn-sm" onClick={handleUpdateName} disabled={loading}>Save</button>
            </div>
          </div>
          <div className="form-group">
            <label>Email</label>
            <input value={user?.email} disabled style={{ opacity: 0.6 }} />
          </div>
        </div>

        <div className="settings-section">
          <h2>Change Password</h2>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
            You'll be signed out of other devices after changing your password.
          </p>
          <div className="form-group">
            <label>New Password</label>
            <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} minLength={6} placeholder="At least 6 characters" />
          </div>
          <button className="btn btn-secondary btn-sm" onClick={handleChangePassword} disabled={loading}>Change Password</button>
        </div>

        <div className="settings-section">
          <h2>Account Actions</h2>
          <div style={{ display: 'flex', gap: '12px' }}>
            <button className="btn btn-secondary btn-sm" onClick={logout}>Logout</button>
            <button className="btn btn-danger btn-sm" onClick={() => setShowDeleteModal(true)}>Delete Account</button>
          </div>
        </div>

        {showDeleteModal && (
          <div className="modal-overlay" onClick={() => setShowDeleteModal(false)}>
            <div className="modal" onClick={e => e.stopPropagation()}>
              <h2>Delete Account</h2>
              <p>This action is permanent. All your data, conversations, and documents will be deleted.</p>
              <div className="modal-actions">
                <button className="btn btn-secondary btn-sm" onClick={() => setShowDeleteModal(false)}>Cancel</button>
                <button className="btn btn-danger btn-sm" onClick={handleDeleteAccount}>Delete Account</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
