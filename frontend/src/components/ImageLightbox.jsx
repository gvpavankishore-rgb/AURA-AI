import { useEffect, memo } from 'react';
import { X } from 'lucide-react';
import SmartImage from './SmartImage';

// Full-size image viewer for chat images. Opens from a click on any message
// image, closes via the close button, backdrop click, or Escape, preserves the
// image's aspect ratio, and fits on mobile screens.
const ImageLightbox = memo(function ImageLightbox({ url, onClose }) {
  const close = onClose;

  useEffect(() => {
    if (!url) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') close?.();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [url, close]);

  if (!url) return null;

  return (
    <div
      className="image-lightbox-overlay"
      onClick={close}
      role="dialog"
      aria-modal="true"
      aria-label="Full-size image"
    >
      <button
        className="image-lightbox-close"
        onClick={close}
        aria-label="Close"
        title="Close"
      >
        <X size={22} />
      </button>
      <SmartImage
        src={url}
        alt=""
        containerClassName="image-lightbox-image"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
});

export default ImageLightbox;