import { useState, memo } from 'react';
import { ImageOff } from 'lucide-react';
import { Skeleton } from './Skeleton';

// Renders an image with a skeleton placeholder and a graceful unavailable state.
//
// `src` changes at runtime: a signed Supabase URL that expired is replaced with
// a freshly minted one, and the component must start over (skeleton again,
// previous error cleared) rather than stay stuck on the placeholder. The state
// reset therefore happens DURING render, not in an effect, so a successful
// retry never paints a frame of "unavailable" first.
function SmartImage({
  src,
  alt = '',
  className = '',
  skeletonClassName = '',
  containerClassName = '',
  mini = false,
  skeletonStyle,
  retrying = false,
  onLoad: onLoadProp,
  onError: onErrorProp,
  ...imgProps
}) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [prevSrc, setPrevSrc] = useState(src);

  if (src !== prevSrc) {
    setPrevSrc(src);
    setLoaded(false);
    setError(false);
  }

  const hasSrc = Boolean(src);

  const placeholder = (label, hint) => (
    <span
      className={`smart-image smart-image-unavailable ${mini ? 'smart-image-mini' : ''} ${containerClassName}`}
      role="img"
      aria-label={alt || label}
      title={hint}
    >
      <ImageOff className="smart-image-unavailable-icon" size={18} aria-hidden="true" />
      <span className="smart-image-unavailable-label">{label}</span>
    </span>
  );

  // Nothing renderable. A pre-migration `uploads/...` attachment lands here:
  // its bytes only ever lived on the backend's ephemeral disk, so there is
  // nothing to fetch. Show the placeholder immediately — no skeleton (which
  // would spin forever with no request to settle it) and, crucially, no request
  // to /uploads that could only ever 404.
  if (!hasSrc) {
    return placeholder('Image unavailable', 'This image predates cloud storage and is no longer available. Re-upload it to restore it.');
  }

  if (error) {
    // A retry is already in flight; hold the skeleton rather than flashing the
    // terminal state for the ~200ms the re-sign takes.
    if (retrying) {
      return (
        <span className={`smart-image ${mini ? 'smart-image-mini' : ''} ${containerClassName}`}>
          <Skeleton className={`smart-image-skeleton ${skeletonClassName}`} style={skeletonStyle} />
        </span>
      );
    }
    return placeholder('Image unavailable', 'This image could not be loaded. It may have been removed from storage.');
  }

  return (
    <span className={`smart-image ${mini ? 'smart-image-mini' : ''} ${containerClassName}`}>
      {!loaded && <Skeleton className={`smart-image-skeleton ${skeletonClassName}`} style={skeletonStyle} />}
      <img
        src={src}
        alt={alt || ''}
        className={className}
        loading="lazy"
        onLoad={(e) => { setLoaded(true); onLoadProp?.(e); }}
        onError={(e) => { setLoaded(true); setError(true); onErrorProp?.(e); }}
        {...imgProps}
      />
    </span>
  );
}

export default memo(SmartImage);
