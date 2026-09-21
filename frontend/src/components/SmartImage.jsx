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
  const hasSrc = Boolean(src);

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
          onError={() => setLoaded(true)}
          {...imgProps}
        />
      )}
    </span>
  );
}

export default memo(SmartImage);