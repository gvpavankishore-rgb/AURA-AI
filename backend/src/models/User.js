import bcrypt from 'bcryptjs';
import { SupabaseModel } from './base.js';

const User = new SupabaseModel('users', {
  allColumns: [
    'id', 'name', 'email', 'password_hash', 'avatar', 'memory_enabled',
    'password_reset_token', 'password_reset_expires', 'created_at', 'updated_at',
  ],
  excludeColumns: ['password_hash'],
  fieldRenames: { password: 'password_hash' },
  columnAliases: { password_hash: 'password' },
  defaults: { avatar: '', memoryEnabled: true },
  beforeWrite: (row) => {
    if (row.password_hash && !row.password_hash.startsWith('$2')) {
      row.password_hash = bcrypt.hashSync(row.password_hash, 12);
    }
  },
});

export default User;