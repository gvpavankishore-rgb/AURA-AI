import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

const NEAR_BOTTOM_THRESHOLD = 160;

export default function useAutoScroll(containerRef, { streaming = false, followToken = 0 } = {}) {
  const [showScrollButton, setShowScrollButton] = useState(false);
  const nearBottomRef = useRef(true);
  const rafRef = useRef(null);
  const followRafRef = useRef(null);
  const showButtonRef = useRef(false);

  const updateButton = useCallback((show) => {
    if (showButtonRef.current === show) return;
    showButtonRef.current = show;
    setShowScrollButton(show);
  }, []);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    nearBottomRef.current = distance <= NEAR_BOTTOM_THRESHOLD;
    updateButton(!nearBottomRef.current);
  }, [containerRef, updateButton]);

  const scrollToBottom = useCallback((smooth = true) => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, left: 0, behavior: smooth ? 'smooth' : 'auto' });
    nearBottomRef.current = true;
    updateButton(false);
  }, [containerRef, updateButton]);

  const updateScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (nearBottomRef.current) {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (distance > 1) el.scrollTop = el.scrollHeight;
    }
  }, [containerRef]);

  useLayoutEffect(updateScroll);

  useEffect(() => {
    if (!followToken) return undefined;
    const el = containerRef.current;
    if (!el) return undefined;
    nearBottomRef.current = true;
    el.scrollTop = el.scrollHeight;
    updateButton(false);
    if (followRafRef.current) cancelAnimationFrame(followRafRef.current);
    followRafRef.current = requestAnimationFrame(() => {
      followRafRef.current = null;
      const current = containerRef.current;
      if (current && nearBottomRef.current) current.scrollTop = current.scrollHeight;
    });
    return () => {
      if (followRafRef.current) {
        cancelAnimationFrame(followRafRef.current);
        followRafRef.current = null;
      }
    };
  }, [followToken, containerRef, updateButton]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    el.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
    return () => el.removeEventListener('scroll', handleScroll);
  }, [containerRef, handleScroll]);

  useEffect(() => {
    if (!streaming) return undefined;
    const el = containerRef.current;
    if (!el) return undefined;
    const tick = () => {
      if (nearBottomRef.current) {
        const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (distance > 1) el.scrollTop = el.scrollHeight;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [streaming, containerRef]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => {
      if (nearBottomRef.current) {
        const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (distance > 1) el.scrollTop = el.scrollHeight;
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef]);

  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    const onViewport = () => updateScroll();
    vv?.addEventListener('resize', onViewport);
    window.addEventListener('resize', onViewport);
    return () => {
      vv?.removeEventListener('resize', onViewport);
      window.removeEventListener('resize', onViewport);
    };
  }, [updateScroll]);

  useEffect(() => () => {
    cancelAnimationFrame(rafRef.current);
    if (followRafRef.current) cancelAnimationFrame(followRafRef.current);
  }, []);

  return { showScrollButton, scrollToBottom };
}