import { SupabaseModel } from './base.js';

const Message = new SupabaseModel('messages', {
  allColumns: ['id', 'conversation_id', 'role', 'content', 'attachments', 'metadata', 'created_at', 'updated_at'],
  defaults: { attachments: [], metadata: {} },
});

export default Message;