import { useState } from 'react';

const DEVELOPER_PHOTO_SRC = '/pavan.jpeg';

const DEVELOPER_STACK = [
  'React',
  'Node.js',
  'Express.js',
  'Supabase',
  'OpenRouter API',
  'AI/LLM',
  'Multimodal AI',
  'Full-stack Web',
];

function DeveloperProfileCard() {
  const [photoError, setPhotoError] = useState(false);

  return (
    <div className="developer-card">
      <div className="developer-photo-wrap">
        {photoError ? (
          <div className="developer-photo developer-photo-fallback" role="img" aria-label="Pavan Kishore">
            PK
          </div>
        ) : (
          <img
            className="developer-photo"
            src={DEVELOPER_PHOTO_SRC}
            alt="Pavan Kishore"
            loading="lazy"
            onError={() => setPhotoError(true)}
          />
        )}
      </div>
      <div className="developer-name">Pavan Kishore</div>
      <div className="developer-role">CSE Student • AI Developer</div>
      <div className="developer-creator">Creator &amp; Developer of AURA AI</div>
      <p className="developer-desc">
        AURA AI is a multimodal AI chatbot project developed by Pavan Kishore. It combines
        conversational AI, image understanding, image tools, voice features, document/PDF
        interaction, chat history, authentication, and modern web technologies.
      </p>
      <div className="developer-stack">
        {DEVELOPER_STACK.map(tag => (
          <span key={tag} className="developer-tag">{tag}</span>
        ))}
      </div>
    </div>
  );
}

export default DeveloperProfileCard;