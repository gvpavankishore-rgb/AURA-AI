import { SupabaseModel } from './base.js';

const Memory = new SupabaseModel('memories', {
  allColumns: ['id', 'user_id', 'content', 'type', 'created_at'],
  defaults: { type: 'custom' },
  setsUpdatedAt: false,
});

export default Memory;