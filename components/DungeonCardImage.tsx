'use client';
import { useState, useRef, useEffect } from 'react';
import Image from 'next/image';

// A dungeon card's cover art: Blizzard's journal tile, then the WCL icon if that
// fails, then nothing (the card keeps its plain background).
//
// What has failed is kept as a list of URLs and the shown image is derived from it,
// rather than holding "current src" in state seeded from props: props can change on a
// client-side re-render of the same mounted card (the image URL missing on first
// render and present later), and derived this way a new URL is simply tried.
export default function DungeonCardImage({ primary, fallback }: { primary?: string; fallback?: string }) {
  const [failed, setFailed] = useState<string[]>([]);
  const imgRef = useRef<HTMLImageElement>(null);
  const src = [primary, fallback].find(u => u && !failed.includes(u));

  const markFailed = (url: string) => setFailed(f => (f.includes(url) ? f : [...f, url]));

  // Catch images that failed before React hydration (their error event already fired).
  useEffect(() => {
    const img = imgRef.current;
    if (src && img && img.complete && img.naturalWidth === 0) markFailed(src);
  }, [src]);

  if (!src) return null;

  return (
    <Image
      ref={imgRef}
      src={src}
      alt=""
      fill
      // Card art from two hosts with a client-side fallback between them: served as-is.
      unoptimized
      className="object-cover opacity-40"
      onError={() => markFailed(src)}
    />
  );
}
