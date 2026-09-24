import { createClient } from '@supabase/supabase-js';

const url = 'https://xdnapeyjvkxxwharzele.supabase.co';
const anon = 'sb_publishable_IPCbIshsPjiMJ3gOD6sQgQ_FUe4SHcl';

const email = `aura-debug3-${Date.now()}@test.com`;
const { data: sig, error: sigErr } = await createClient(url, anon).auth.signUp({
  email,
  password: 'testpass123',
});
if (sigErr) { console.log('SIGNUP ERROR:', sigErr.message); process.exit(1); }
const token = sig.session.access_token;
console.log('SIGNUP OK. token length:', token.length);

// FIXED scoped client: real anon key + Authorization header override.
const scoped = createClient(url, anon, {
  global: { headers: { Authorization: `Bearer ${token}` } },
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});

const { data, error } = await scoped.auth.getUser(token);
console.log('getUser error:', error ? JSON.stringify(error) : null);
console.log('getUser user.id:', data?.user?.id || null);

const { data: users, error: usersErr } = await scoped.from('users').select('id,email').limit(5);
console.log('REST users error:', usersErr ? JSON.stringify(usersErr) : null);
console.log('REST users count:', Array.isArray(users) ? users.length : null);

const { data: conv, error: convErr } = await scoped.from('conversations').select('id').limit(5);
console.log('REST conversations error:', convErr ? JSON.stringify(convErr) : null);
console.log('REST conversations count:', Array.isArray(conv) ? conv.length : null);