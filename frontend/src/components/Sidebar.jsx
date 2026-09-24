import { useState, useEffect, useRef, useCallback, memo } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useTranslation } from '../i18n';
import api from '../services/api';
import { ChatListSkeleton } from './Skeleton';
import { Plus, Search, Pin, Trash2, MoreHorizontal, Pencil, Check, X, MessageSquare } from 'lucide-react';

const CHATS_PER_PAGE = 50;
const SEARCH_DEBOUNCE_MS = 400;

const chatTime = (c) => new Date(c.updatedAt || c.createdAt || 0).getTime();

const sortChats = (list) =>
  [...list].sort((a, b) => ((b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)) || chatTime(b) - chatTime(a));

const mergeChats = (prev, incoming) => {
  const seen = new Set(prev.map(c => c._id));
  const out = [...prev];
  for (const c of incoming) {
    if (!seen.has(c._id)) {
      seen.add(c._id);
      out.push(c);
    }
  }
  return out;
};

const SidebarChatItem = memo(function SidebarChatItem({ chat, isActive, editing, menuOpen, onOpen, onStartEdit, onCancelEdit, onRename, onPin, onDelete, onMenuToggle }) {
  const [title, setTitle] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    if (editing) setTitle(chat.title || '');
  }, [editing, chat.title]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const submitRename = () => {
    if (!title.trim()) { onCancelEdit(); return; }
    onRename(chat._id, title.trim());
  };

  return (
    <div
      className={`chat-item ${isActive ? 'active' : ''}`}
      onClick={() => onOpen(chat._id)}
    >
      {editing ? (
        <div style={{ display: 'flex', gap: 4, flex: 1, alignItems: 'center' }} onClick={e => e.stopPropagation()}>
          <input
            ref={inputRef}
            value={title}
            onChange={e => setTitle(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submitRename(); if (e.key === 'Escape') onCancelEdit(); }}
            style={{ flex: 1, padding: '2px 6px', fontSize: 12 }}
          />
          <button className="btn-ghost" style={{ padding: 2 }} onClick={submitRename}><Check size={12} /></button>
          <button className="btn-ghost" style={{ padding: 2 }} onClick={onCancelEdit}><X size={12} /></button>
        </div>
      ) : (
        <>
          <span className="chat-title">{chat.title || 'New Chat'}</span>
          <div className="chat-actions" onClick={e => e.stopPropagation()}>
            <button
              onClick={() => onMenuToggle(chat._id)}
              title="More"
            >
              <MoreHorizontal size={14} />
            </button>
          </div>
        </>
      )}

      {menuOpen && (
        <div
          style={{
            position: 'absolute', right: 8, top: '100%', zIndex: 50,
            background: 'var(--bg-secondary)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)', padding: 4, minWidth: 140,
            boxShadow: 'var(--shadow-md)',
          }}
          onClick={e => e.stopPropagation()}
        >
          <button
            style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '6px 8px', fontSize: 12, borderRadius: 'var(--radius-xs)', color: 'var(--text-secondary)' }}
            className="sidebar-nav-item"
            onMouseEnter={e => e.target.style.background = 'var(--bg-hover)'}
            onMouseLeave={e => e.target.style.background = 'transparent'}
            onClick={() => onStartEdit(chat)}
          >
            <Pencil size={12} /> Rename
          </button>
          <button
            style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '6px 8px', fontSize: 12, borderRadius: 'var(--radius-xs)', color: 'var(--text-secondary)' }}
            className="sidebar-nav-item"
            onMouseEnter={e => e.target.style.background = 'var(--bg-hover)'}
            onMouseLeave={e => e.target.style.background = 'transparent'}
            onClick={() => onPin(chat._id, chat.pinned)}
          >
            <Pin size={12} /> {chat.pinned ? 'Unpin' : 'Pin'}
          </button>
          <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
          <button
            style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '6px 8px', fontSize: 12, borderRadius: 'var(--radius-xs)', color: 'var(--danger)' }}
            className="sidebar-nav-item"
            onMouseEnter={e => e.target.style.background = 'rgba(239,68,68,0.08)'}
            onMouseLeave={e => e.target.style.background = 'transparent'}
            onClick={() => onDelete(chat._id)}
          >
            <Trash2 size={12} /> Delete
          </button>
        </div>
      )}
    </div>
  );
});

export default function Sidebar({ open, onClose }) {
  const { user, logout } = useAuth();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [chats, setChats] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const chatsScrollRef = useRef(null);
  const reqIdRef = useRef(0);
  const pageRef = useRef(1);
  const hasMoreRef = useRef(false);
  const loadingRef = useRef(false);
  const loadingMoreRef = useRef(false);
  const searchRef = useRef(searchQuery);
  const lastQueryRef = useRef('');
  searchRef.current = searchQuery;

  const fetchChats = useCallback(async ({ reset }) => {
    if (!reset && (loadingRef.current || loadingMoreRef.current)) return;
    const rid = ++reqIdRef.current;
    const targetPage = reset ? 1 : pageRef.current + 1;
    const q = searchRef.current;
    if (reset) {
      loadingRef.current = true;
      setLoading(true);
    } else {
      loadingMoreRef.current = true;
      setLoadingMore(true);
    }
    try {
      const params = { page: targetPage, limit: CHATS_PER_PAGE };
      if (q) params.search = q;
      const res = await api.getChats(params);
      if (rid !== reqIdRef.current) return;
      const data = res.data || [];
      const list = Array.isArray(data) ? data : data.chats || [];
      const more = Array.isArray(data) ? false : Boolean(data.hasMore);
      setChats(prev => (reset ? list : sortChats(mergeChats(prev, list))));
      pageRef.current = targetPage;
      hasMoreRef.current = more;
      setHasMore(more);
    } catch {
      if (rid !== reqIdRef.current) return;
      if (reset) setChats([]);
    } finally {
      if (rid !== reqIdRef.current) return;
      loadingRef.current = false;
      loadingMoreRef.current = false;
      if (reset) setLoading(false);
      else setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    if (!user) {
      setChats([]);
      setEditingId(null);
      setContextMenu(null);
      pageRef.current = 1;
      hasMoreRef.current = false;
      setHasMore(false);
      return;
    }
    lastQueryRef.current = searchRef.current;
    fetchChats({ reset: true });
  }, [user, fetchChats]);

  useEffect(() => {
    if (!user) return;
    if (searchRef.current === lastQueryRef.current) return;
    const timer = setTimeout(() => {
      lastQueryRef.current = searchRef.current;
      fetchChats({ reset: true });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchQuery, user, fetchChats]);

  useEffect(() => {
    if (!user) return;
    let timer = null;
    const onHistoryUpdated = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fetchChats({ reset: true }), 300);
    };
    window.addEventListener('aura:history-updated', onHistoryUpdated);
    return () => {
      window.removeEventListener('aura:history-updated', onHistoryUpdated);
      if (timer) clearTimeout(timer);
    };
  }, [user, fetchChats]);

  const handleChatsScroll = useCallback(() => {
    const el = chatsScrollRef.current;
    if (!el) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 240) {
      if (hasMoreRef.current && !loadingRef.current && !loadingMoreRef.current) {
        fetchChats({ reset: false });
      }
    }
  }, [fetchChats]);

  useEffect(() => {
    const el = chatsScrollRef.current;
    if (!el) return undefined;
    el.addEventListener('scroll', handleChatsScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleChatsScroll);
  }, [handleChatsScroll]);

  const handleNewChat = useCallback(() => {
    window.dispatchEvent(new CustomEvent('aura:new-chat'));
    if (location.pathname !== '/chat') navigate('/chat');
    onClose();
  }, [location.pathname, navigate, onClose]);

  const handleOpenChat = useCallback((id) => {
    navigate(`/chat/${id}`);
    onClose();
  }, [navigate, onClose]);

  const handleRename = useCallback(async (id, title) => {
    try { await api.updateChat(id, { title }); } catch { /* server state not critical for UI */ }
    reqIdRef.current += 1;
    setChats(prev => prev.map(c => (c._id === id ? { ...c, title } : c)));
    setEditingId(null);
  }, []);

  const handlePin = useCallback(async (id, pinned) => {
    try { await api.updateChat(id, { pinned: !pinned }); } catch { /* server state not critical for UI */ }
    reqIdRef.current += 1;
    setChats(prev => sortChats(prev.map(c => (c._id === id ? { ...c, pinned: !pinned } : c))));
    setContextMenu(null);
  }, []);

  const handleDelete = useCallback(async (id) => {
    try { await api.deleteChat(id); } catch { /* ignore */ }
    reqIdRef.current += 1;
    setContextMenu(null);
    if (location.pathname === `/chat/${id}`) navigate('/chat');
    setChats(prev => prev.filter(c => c._id !== id));
  }, [location.pathname, navigate]);

  const handleLogout = useCallback(async () => {
    await logout();
    navigate('/chat');
    onClose();
  }, [logout, navigate, onClose]);

  const isChatActive = useCallback((chatId) => location.pathname === `/chat/${chatId}`, [location.pathname]);

  const startEdit = useCallback((chat) => {
    setContextMenu(null);
    setEditingId(chat._id);
  }, []);

  const cancelEdit = useCallback(() => setEditingId(null), []);

  const toggleMenu = useCallback((id) => {
    setContextMenu(prev => (prev === id ? null : id));
  }, []);

  const pinnedChats = chats.filter(c => c.pinned);
  const unpinnedChats = chats.filter(c => !c.pinned);

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const isToday = (c) => chatTime(c) >= startOfToday.getTime();
  const todayChats = unpinnedChats.filter(isToday);
  const olderChats = unpinnedChats.filter(c => !isToday(c));

  const renderSections = () => (
    <>
      {pinnedChats.length > 0 && (
        <>
          <div className="section-label">Pinned</div>
          {pinnedChats.map(chat => (
            <SidebarChatItem
              key={chat._id}
              chat={chat}
              isActive={isChatActive(chat._id)}
              editing={editingId === chat._id}
              menuOpen={contextMenu === chat._id}
              onOpen={handleOpenChat}
              onStartEdit={startEdit}
              onCancelEdit={cancelEdit}
              onRename={handleRename}
              onPin={handlePin}
              onDelete={handleDelete}
              onMenuToggle={toggleMenu}
            />
          ))}
        </>
      )}
      {todayChats.length > 0 && (
        <>
          <div className="section-label">Today</div>
          {todayChats.map(chat => (
            <SidebarChatItem
              key={chat._id}
              chat={chat}
              isActive={isChatActive(chat._id)}
              editing={editingId === chat._id}
              menuOpen={contextMenu === chat._id}
              onOpen={handleOpenChat}
              onStartEdit={startEdit}
              onCancelEdit={cancelEdit}
              onRename={handleRename}
              onPin={handlePin}
              onDelete={handleDelete}
              onMenuToggle={toggleMenu}
            />
          ))}
        </>
      )}
      {olderChats.length > 0 && (
        <>
          <div className="section-label">Older</div>
          {olderChats.map(chat => (
            <SidebarChatItem
              key={chat._id}
              chat={chat}
              isActive={isChatActive(chat._id)}
              editing={editingId === chat._id}
              menuOpen={contextMenu === chat._id}
              onOpen={handleOpenChat}
              onStartEdit={startEdit}
              onCancelEdit={cancelEdit}
              onRename={handleRename}
              onPin={handlePin}
              onDelete={handleDelete}
              onMenuToggle={toggleMenu}
            />
          ))}
        </>
      )}
    </>
  );

  return (
    <>
      <div className={`sidebar-overlay ${open ? 'open' : ''}`} onClick={onClose} />
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="sidebar-header">
          <div className="sidebar-logo">
            <div className="logo-icon">A</div>
            <span>AURA AI</span>
          </div>
        </div>

        <div className="sidebar-new-chat">
          <button className="btn" onClick={handleNewChat}>
            <Plus size={16} />
            <span>{t('sidebar.newChat')}</span>
          </button>
        </div>

        <nav className="sidebar-nav">
          <NavLink
            to="/chat"
            className={({ isActive }) => `sidebar-nav-item ${isActive && !location.pathname.includes('/chat/') ? 'active' : ''}`}
            onClick={onClose}
          >
            <MessageSquare size={16} />
            <span>{t('nav.chat')}</span>
          </NavLink>
        </nav>

        {user && (
          <>
            <div className="search-box">
              <Search size={14} />
              <input
                type="text"
                placeholder={t('sidebar.searchChats')}
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
              />
            </div>

            <div className="sidebar-chats" ref={chatsScrollRef}>
              {loading ? (
                <ChatListSkeleton count={6} />
              ) : chats.length === 0 ? (
                <div className="no-chats">
                  {searchQuery ? 'No matching chats' : t('sidebar.noChats')}
                </div>
              ) : (
                <>
                  {renderSections()}
                  {loadingMore && (
                    <div className="sidebar-loading-more">
                      <span className="att-spinner" /> Loading more chats...
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}

        {!user && (
          <div className="sidebar-chats">
            <div style={{ padding: '20px 12px', textAlign: 'center' }}>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 10, lineHeight: 1.5 }}>
                Sign in to save and access your chats
              </div>
              <button
                className="btn btn-primary btn-sm"
                style={{ width: '100%' }}
                onClick={() => { onClose(); navigate('/login'); }}
              >
                Sign In
              </button>
              <button
                className="btn btn-secondary btn-sm"
                style={{ width: '100%', marginTop: 6 }}
                onClick={() => { onClose(); navigate('/register'); }}
              >
                Create Account
              </button>
            </div>
          </div>
        )}

        {user && (
          <div className="sidebar-bottom">
            <NavLink to="/profile" className="avatar" onClick={onClose} style={{ textDecoration: 'none' }}>
              {user.name?.[0]?.toUpperCase() || 'U'}
            </NavLink>
            <NavLink to="/profile" onClick={onClose} style={{ textDecoration: 'none', color: 'inherit', flex: 1, minWidth: 0 }}>
              <div className="user-info">
                <div className="user-name">{user.name}</div>
                <div className="user-email">{user.email}</div>
              </div>
            </NavLink>
            <NavLink to="/settings" className="btn-ghost" title="Settings" onClick={onClose}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            </NavLink>
            <button onClick={handleLogout} className="btn-ghost" title="Sign out">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
            </button>
          </div>
        )}
      </aside>
    </>
  );
}