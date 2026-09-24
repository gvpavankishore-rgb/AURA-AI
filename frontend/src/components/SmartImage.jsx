import { useState, memo } from 'react';
import { Skeleton } from './Skeleton';

function SmartImage({
  src,
  alt = '',
  className = '',
  skeletonClassName = '',
  containerClassName = '',
  mini = false,
  skeletonStyle,
  ...imgProps
}) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const hasSrc = Boolean(src);

  if (error) {
    return (
      <span
        className={`smart-image ${mini ? 'smart-image-mini' : ''} ${containerClassName}`}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', minHeight: 90, padding: 12, boxSizing: 'border-box', borderRadius: 12, background: 'rgba(255,255,255,0.04)', border: '1px dashed rgba(255,255,255,0.18)', color: '#8a8a93', fontSize: 12, textAlign: 'center' }}
      >
        Image unavailable
      </span>
    );
  }

  return (
    <span className={`smart-image ${mini ? 'smart-image-mini' : ''} ${containerClassName}`}>
      {!loaded && <Skeleton className={`smart-image-skeleton ${skeletonClassName}`} style={skeletonStyle} />}
      {hasSrc && (
        <img
          src={src}
          alt={alt || ''}
          className={className}
          loading="lazy"
          onLoad={() => setLoaded(true)}
          onError={() => { setLoaded(true); setError(true); }}
          {...imgProps}
        />
      )}
    </span>
  );
}

export default memo(SmartImage);