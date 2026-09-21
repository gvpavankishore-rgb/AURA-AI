import { useEffect, useRef, useState, memo } from 'react';
import { Camera, X, AlertTriangle } from 'lucide-react';
import SmartImage from './SmartImage';

export const ImagePreviewOverlay = memo(function ImagePreviewOverlay({ url, onClose }) {
  if (!url) return null;
  return (
    <div className="image-preview-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Image preview">
      <button className="image-preview-close" onClick={onClose} aria-label="Close image preview" title="Close">
        <X size={18} />
      </button>
      <SmartImage
        src={url}
        alt="Preview"
        mini
        containerClassName="image-preview-image"
        onClick={e => e.stopPropagation()}
        skeletonStyle={{ width: 'min(60vw, 420px)', height: 'min(45vh, 280px)', borderRadius: 16 }}
      />
    </div>
  );
});

export const CameraOverlay = memo(function CameraOverlay({ open, onClose, onCapture }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);

  const stopStream = () => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    setReady(false);
  };

  const openCamera = async () => {
    setError('');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setError('Camera is not supported in this browser.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      stopStream();
      streamRef.current = stream;
      setReady(true);
    } catch {
      streamRef.current = null;
      setError('Camera access was denied or unavailable. Check browser permissions and try again.');
    }
  };

  useEffect(() => {
    if (!open) {
      stopStream();
      setError('');
      return;
    }
    openCamera();
    return () => stopStream();
  }, [open]);

  useEffect(() => {
    if (ready && streamRef.current && videoRef.current) {
      videoRef.current.srcObject = streamRef.current;
      videoRef.current.play().catch(() => {});
    }
  }, [ready, open]);

  const capturePhoto = () => {
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!video || !stream || !video.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) return;
      onCapture?.(new File([blob], 'capture.jpg', { type: 'image/jpeg' }));
      onClose?.();
    }, 'image/jpeg', 0.92);
  };

  if (!open) return null;

  return (
    <div className="camera-overlay" role="dialog" aria-modal="true" aria-label="Camera capture">
      <div className="camera-modal">
        <div className="camera-head">
          <span className="camera-title"><Camera size={16} /> Capture photo</span>
          <button className="image-preview-close" onClick={onClose} aria-label="Close camera" title="Close">
            <X size={18} />
          </button>
        </div>
        {error ? (
          <div className="camera-error">
            <AlertTriangle size={22} />
            <p>{error}</p>
            <button className="btn btn-secondary btn-sm" onClick={openCamera}>Try again</button>
          </div>
        ) : (
          <>
            <div className="camera-viewport">
              <video ref={videoRef} playsInline muted autoPlay />
            </div>
            <div className="camera-actions">
              <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
              <button className="camera-capture" onClick={capturePhoto} aria-label="Capture photo" title="Capture photo">
                <Camera size={22} />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
});