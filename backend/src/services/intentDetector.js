// Lightweight intent detection used to route prompts to the right AI mode.
// Kept deliberately dependency-free and fast to run on every message.

const CODING_PATTERNS = [
  /^(give me|show me|write|make|build|create|generate|construct|implement)\s+(a\s+)?(code|program|script|function|component|app|api|query|sql|cli|daemon|module)/i,
  /^(write|create|generate|build|fix|debug)\s+(a\s+)?(react|node|python|java|c\+\+|c#|javascript|typescript|html|css|sql|rust|go|php|ruby|django|flask|express|next\.js|vite)(\s+(app|component|project|script|function))?/i,
  /convert this design into code/i,
  /convert (this|the) (image|ui|design|screenshot|mockup)(\s+from the image)? into code/i,
  /(write|create|generate|recreate|build).*(code|html|css|react|component|ui) from this image/i,
  /code from this image/i,
  /ui from this image/i,
  /(write|create|generate).*(html|css|react) (code|component|page|ui)?/i,
  /(fix|solve|debug).*(error|bug|issue|problem|exception|stack.?trace)(.*\n.*)?/i,
  /^(fix this error|debug this|solve this error|help me debug)/i,
  /(error|exception|traceback):\s*/i,
  /\bselect\s.+\sfrom\s+\w+/i,
  /^(how do i|how to|can you write|please write|could you write)/i,
];

const VISION_HINT_PATTERNS = [
  /analyze this image/i,
  /describe this image/i,
  /tell me about this image/i,
  /what('s| is) in this image/i,
  /(read|extract|scan) (the )?(text|code) (from|in) (this )?image/i,
  /code from (this|the) image/i,
  /write code from (this|the) image/i,
  /create ui from (this|the) image/i,
  /convert this (screenshot|design|ui|image) into (code|html|css|react)/i,
  /fix (this|the) error (in|from) (this|the) image/i,
];

export const isCodingRequest = (text = '') => {
  const t = String(text || '').trim();
  if (!t) return false;
  return CODING_PATTERNS.some((re) => re.test(t));
};

export const isVisionHint = (text = '') => {
  const t = String(text || '').trim();
  if (!t) return false;
  return VISION_HINT_PATTERNS.some((re) => re.test(t));
};