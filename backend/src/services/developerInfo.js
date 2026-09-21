export const DEVELOPER = {
  name: 'Pavan Kishore',
  role: 'Computer Science Engineering Student / AI & Full-Stack Developer',
  title: 'CSE Student • AI Developer',
  project: 'AURA AI',
  summary: 'AURA AI is a multimodal AI chatbot project developed by Pavan Kishore. The project combines conversational AI, image understanding, image tools, voice features, document/PDF interaction, chat history, authentication, and modern web technologies.',
  stack: ['React', 'Node.js', 'Express.js', 'Supabase', 'OpenRouter API', 'AI/LLM', 'Multimodal AI', 'Full-stack Web'],
};

export const getDeveloperContextPrompt = () => `
Creator information you must know:
AURA AI was created and developed by Pavan Kishore, a Computer Science Engineering student and AI/Full-Stack developer. Pavan Kishore is the sole creator and developer of the AURA AI application.
AURA AI is a multimodal AI chatbot project that combines conversational AI, image understanding, image tools, voice features, document/PDF interaction, chat history, authentication, and modern web technologies built with React, Node.js, Express.js, Supabase, OpenRouter API, AI/LLM integration, multimodal AI, and full-stack web development.
IMPORTANT: When the user asks who created AURA AI, who built you, who developed you, who made this AI, or about the developer/creator behind AURA AI, state clearly that AURA AI was created and developed by Pavan Kishore. Never claim AURA AI was created by OpenAI, Google, Anthropic, DeepSeek, or OpenRouter. OpenRouter and the selected AI model are service/model providers used by AURA AI, not the creators of the AURA AI application.
Keep creator-related answers professional and concise. Do not invent personal details such as college, phone number, email, address, social media accounts, or age.`;

const DEVELOPER_PATTERNS = [
  /\bwho\s+(created|built|developed|made|designed|coded|programmed|wrote|constructed)\s+(you|this\b|this\s+(?:ai|app|bot|chatbot|project)\b|aura(?:\s+ai)?)\b/i,
  /\bwho\s+(is|was)\s+(your|the|their)?\s*(developer|creator|maker|builder|founder|owner)\b/i,
  /\b(?:tell\s+me|talk|speak|chat).{0,12}\b(?:about|regarding)\s+(?:the|your)\s*(developer|creator|author|maker)\b/i,
  /\b(?:developer|creator|author|maker|builder)\s+(?:of|behind)\s+aura(?:\s+ai)?\b/i,
  /\bwho\s+is\s+behind\s+(aura(?:\s+ai)?|you|this\s+(?:app|ai|chatbot|project))\b/i,
  /\b(?:about|regarding)\s+(?:the|your)\s*(developer|creator|author|maker)(?:\s*(?:of\s+)?aura(?:\s+ai)?)?\b/i,
];

export const isDeveloperQuery = (text) => {
  const input = String(text || '').trim();
  if (!input) return false;
  return DEVELOPER_PATTERNS.some((re) => re.test(input));
};