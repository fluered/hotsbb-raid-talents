'use client';
import { useState, useRef, useEffect } from 'react';

export default function DungeonCardImage({ primary, fallback }: { primary?: string; fallback?: string }) {
  const initialSrc = primary || fallback;
  const [src, setSrc] = useState(initialSrc);
  const [dead, setDead] = useState(!initialSrc);
  const imgRef = useRef<HTMLImageElement>(null);

  const tryFallback = () => {
    if (src !== fallback && fallback) {
      setSrc(fallback);
    } else {
      setDead(true);
    }
  };

  // Catch images that failed before React hydration
  useEffect(() => {
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth === 0) {
      tryFallback();
    }
  }, []);

  if (dead || !src) return null;

  return (
    <img
      ref={imgRef}
      src={src}
      alt=""
      className="absolute inset-0 w-full h-full object-cover opacity-40"
      onError={tryFallback}
    />
  );
}
