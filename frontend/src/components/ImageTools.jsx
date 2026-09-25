import { useCallback, useEffect, useRef, useState, memo } from 'react';
import { Camera, X, AlertTriangle, Check, Repeat } from 'lucide-react';
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
  const [facing, setFacing] = useState('environment');
  const [captured, setCaptured] = useState(null);
  const [capturedUrl, setCapturedUrl] = useState(null);

  const stopStream = () => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    setReady(false);
  };

  const openCamera = useCallback(async (facingMode) => {
    setError('');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setError('Camera is not supported in this browser.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      stopStream();
      streamRef.current = stream;
      setReady(true);
    } catch {
      streamRef.current = null;
      if (facingMode === 'user') {
        setError('Front camera was unavailable. Try switching to the back camera or check permissions.');
      } else {
        setError(facingMode === 'user' ? 'Camera access was denied or unavailable. Check browser permissions and try again.\n\nIf another app is using the camera, close it and retry.' : 'Camera access was denied or unavailable. Check browser permissions and try again.');
      }
    }
  }, []);

  const flipCamera = () => {
    stopStream();
    const next = facing === 'environment' ? 'user' : 'environment';
    setFacing(next);
    setCaptured(null);
    resetCaptureUrl();
    requestAnimationFrame(() => openCamera(next));
  };

  useEffect(() => {
    if (!open) {
      stopStream();
      setError('');
      setCaptured(null);
      resetCaptureUrl();
      return;
    }
    openCamera(facing);
    return () => stopStream();
  }, [open]);

  useEffect(() => {
    if (open && streamRef.current) openCamera(facing);
  }, [facing]);

  useEffect(() => {
    if (ready && streamRef.current && videoRef.current) {
      videoRef.current.srcObject = streamRef.current;
      videoRef.current.play().catch(() => {});
    }
  }, [ready, open]);

  const retakePhoto = () => {
    setCaptured(null);
    resetCaptureUrl();
    setError('');
    openCamera(facing);
  };

  const confirmPhoto = () => {
    if (captured) {
      onCapture?.(new File([captured], 'capture.jpg', { type: 'image/jpeg' }));
    }
    onClose?.();
  };

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
      let url = '';
      try { url = URL.createObjectURL(blob); } catch { /* keep empty */ }
      setCaptured(blob);
      setCapturedUrl(url);
    }, 'image/jpeg', 0.92);
  };

  const resetCaptureUrl = () => {
    setCapturedUrl(u => {
      try { if (u?.startsWith('blob:')) URL.revokeObjectURL(u); } catch { /* ignore */ }
      return null;
    });
  };

  const videoReady = ready && !captured && !error;

  return (
    <div className="camera-overlay" role="dialog" aria-modal="true" aria-label="Camera capture">
      <div className="camera-modal">
        <div className="camera-head">
          <span className="camera-title"><Camera size={16} /> Capture photo</span>
          <button className="image-preview-close" onClick={onClose} aria-label="Close camera" title="Close">
            <X size={18} />
          </button>
        </div>
        {error && !videoReady ? (
          <div className="camera-error">
            <AlertTriangle size={22} />
            <p>{error}</p>
          </div>
        ) : null}
        {videoReady && (
          <>
            <div className="camera-viewport">
              <video ref={videoRef} playsInline muted autoPlay />
            </div>
            <div className="camera-actions">
              <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
              <button className="camera-flip" onClick={flipCamera} aria-label="Switch camera" title="Switch camera">
                <Repeat size={20} />
              </button>
              <button className="camera-capture" onClick={capturePhoto} aria-label="Capture photo" title="Capture photo">
                <Camera size={22} />
              </button>
            </div>
          </>
        )}
        {!videoReady && !error && captured && (
          <>
            <div className="camera-viewport camera-review">
              {capturedUrl ? <SmartImage src={capturedUrl} alt="Captured photo preview" mini containerClassName="smart-image-fill" /> : null}
            </div>
            <div className="camera-actions">
              <button className="btn btn-secondary" onClick={retakePhoto}>Retake</button>
              <button className="camera-capture confirm" onClick={confirmPhoto} aria-label="Use photo" title="Use photo">
                <Check size={22} />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
});