const ACTION_ALLOWLIST = [
  { id: 'youtube', label: 'YouTube', url: 'https://www.youtube.com' },
  { id: 'google', label: 'Google', url: 'https://www.google.com' },
  { id: 'github', label: 'GitHub', url: 'https://github.com' },
  { id: 'gmail', label: 'Gmail', url: 'https://mail.google.com' },
  { id: 'whatsapp', label: 'WhatsApp Web', url: 'https://web.whatsapp.com' },
  { id: 'facebook', label: 'Facebook', url: 'https://www.facebook.com' },
  { id: 'instagram', label: 'Instagram', url: 'https://www.instagram.com' },
];

const EXTRA_ALIASES = {
  yt: 'youtube',
  googlecom: 'google',
  googlesearch: 'google',
  email: 'gmail',
  mail: 'gmail',
  googlemail: 'gmail',
  wa: 'whatsapp',
  'whatsapp web': 'whatsapp',
  fb: 'facebook',
  insta: 'instagram',
  ig: 'instagram',
};

const buildAliases = () => {
  const map = { ...EXTRA_ALIASES };
  for (const site of ACTION_ALLOWLIST) {
    map[site.id] = site.id;
    map[site.id.replace(/\s+/g, '')] = site.id;
    map[`${site.id}.com`] = site.id;
    const host = site.url.replace(/^https?:\/\//, '').replace(/\/+$/, '').replace(/^www\./, '');
    map[host] = site.id;
    map[`www.${host}`] = site.id;
  }
  return map;
};

const OPEN_VERB = 'open(?:\\s+up)?|launch|go\\s+to|take\\s+me\\s+to|navigate\\s+to|visit|browse(?:\\s+to)?';
const POLITE = '(?:(?:please|kindly)\\s+)?(?:(?:can|could|will|would|do)\\s+(?:you|u)\\s+)?';
const ACTION_RE = new RegExp(`^${POLITE}(?:${OPEN_VERB})\\s+(.+)$`, 'i');

const SITE_SHAPE = /^(([a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?(\/.*)?$/;
const TRAILING_JUNK = /\s+(please|kindly|now|for\s+me|in\s+a\s+new\s+tab|in\s+new\s+tab|today|immediately)$/;

const cleanTarget = (raw) => (
  String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(TRAILING_JUNK, '')
    .replace(/[.!,?;:"')\]]+$/g, '')
    .trim()
);

const looksLikeSite = (t) => SITE_SHAPE.test(t) || /^https?:\/\//.test(t);

export const detectAction = (text) => {
  const input = String(text || '').trim();
  if (!input) return null;

  const match = input.match(ACTION_RE);
  if (!match) return null;

  const target = cleanTarget(match[1]);
  if (!target) return null;

  const siteId = buildAliases()[target];
  if (siteId) {
    const site = ACTION_ALLOWLIST.find(s => s.id === siteId);
    if (site) {
      return {
        type: 'action_confirmation',
        action: 'open_url',
        target: site.id,
        label: site.label,
        url: site.url,
        message: `AURA wants to open ${site.label}.`,
      };
    }
  }

  if (looksLikeSite(target)) {
    return { type: 'unsupported_action', target };
  }

  return null;
};

export const buildUnsupportedMessage = (target) =>
  `I can't open ${target}. For safety, I can only open approved apps: YouTube, Google, GitHub, Gmail, WhatsApp, Facebook, or Instagram.`;