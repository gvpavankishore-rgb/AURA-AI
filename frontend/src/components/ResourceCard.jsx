import { useState } from 'react';
import { Check, Copy, ExternalLink, Share2 } from 'lucide-react';

// Generic, dynamic resource card. Every value it renders was validated on the
// server against the actual web-search evidence (link + image URLs must come
// from the search, and title/description/metadata must be supported by it), so
// this component only lays data out - it never derives or guesses anything.
//
// `resource` shape:
//   {
//     type, title, description, images: [url],
//     primaryLink, primaryLinkLabel,
//     metadata: [{ label, value }],
//     source: { title, url } | null,
//     evidence: [{ title, url }]
//   }

const TYPE_ICONS = {
  video: '🎬',
  movie_trailer: '🎬',
  website: '🌐',
  documentation: '📚',
  repository: '💻',
  product: '🛒',
  article: '📰',
  map: '📍',
  booking: '📅',
  download: '⬇️',
  other: '🔗',
};

export default function ResourceCard({ resource }) {
  const [copied, setCopied] = useState(false);
  const [broken, setBroken] = useState([]);

  if (!resource || !resource.primaryLink || !resource.title) return null;

  const icon = TYPE_ICONS[resource.type] || TYPE_ICONS.other;
  const images = (Array.isArray(resource.images) ? resource.images : [])
    .filter((url) => url && !broken.includes(url));
  const metadata = Array.isArray(resource.metadata) ? resource.metadata : [];

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(resource.primaryLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  };

  const shareLink = async () => {
    const text = `${resource.title}${resource.description ? ` - ${resource.description}` : ''}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: resource.title, text, url: resource.primaryLink });
        return;
      }
    } catch { /* user cancelled or unsupported */ }
    copyLink();
  };

  return (
    <div className="resource-card">
      {images.length > 0 && (
        <div className={`resource-card-images count-${Math.min(images.length, 3)}`}>
          {images.slice(0, 3).map((url, i) => (
            <img
              key={`${url}-${i}`}
              src={url}
              alt={i === 0 ? resource.title : ''}
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={() => setBroken((prev) => (prev.includes(url) ? prev : [...prev, url]))}
            />
          ))}
        </div>
      )}

      <div className="resource-card-body">
        <div className="resource-card-heading">
          <span className="resource-card-icon" aria-hidden="true">{icon}</span>
          <h4 className="resource-card-title">{resource.title}</h4>
        </div>

        {resource.description && <p className="resource-card-description">{resource.description}</p>}

        {metadata.length > 0 && (
          <dl className="resource-card-meta">
            {metadata.map((entry, i) => (
              <div className="resource-card-meta-row" key={`${entry.label}-${i}`}>
                <dt>{entry.label}</dt>
                <dd>{entry.value}</dd>
              </div>
            ))}
          </dl>
        )}

        <div className="resource-card-actions">
          <a
            className="resource-card-primary"
            href={resource.primaryLink}
            target="_blank"
            rel="noopener noreferrer"
          >
            <span>{resource.primaryLinkLabel || 'Open'}</span>
            <ExternalLink size={14} aria-hidden="true" />
          </a>
          <button type="button" className="resource-card-action-btn" onClick={copyLink} title="Copy link">
            {copied ? <Check size={14} /> : <Copy size={14} />}
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
          <button type="button" className="resource-card-action-btn" onClick={shareLink} title="Share">
            <Share2 size={14} />
            <span>Share</span>
          </button>
        </div>

        {resource.source && resource.source.url && (
          <a
            className="resource-card-source"
            href={resource.source.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            {resource.source.title}
          </a>
        )}
      </div>
    </div>
  );
}
