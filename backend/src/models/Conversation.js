import { SupabaseModel } from './base.js';

const Conversation = new SupabaseModel('conversations', {
  allColumns: ['id', 'user_id', 'title', 'pinned', 'archived', 'mode', 'created_at', 'updated_at'],
  defaults: { title: 'New Chat', pinned: false, archived: false, mode: 'chat' },
});

export default Conversation;