export const ACTION_SITES = [
  { id: 'youtube', label: 'YouTube', url: 'https://www.youtube.com' },
  { id: 'google', label: 'Google', url: 'https://www.google.com' },
  { id: 'github', label: 'GitHub', url: 'https://github.com' },
  { id: 'gmail', label: 'Gmail', url: 'https://mail.google.com' },
  { id: 'whatsapp', label: 'WhatsApp Web', url: 'https://web.whatsapp.com' },
  { id: 'facebook', label: 'Facebook', url: 'https://www.facebook.com' },
  { id: 'instagram', label: 'Instagram', url: 'https://www.instagram.com' },
];

export const findSiteByAction = (action) => {
  if (!action || !action.target || !action.url) return null;
  return ACTION_SITES.find(s => s.id === action.target && s.url === action.url) || null;
};

export const isSafeOpenUrl = (url) => ACTION_SITES.some(s => s.url === url);