'use client';

import React, { useState } from 'react';

interface CopyButtonProps {
  text: string;
}

export default function CopyButton({ text }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!text || text === 'No code found') return;
    
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      // Reset button text back to "Copy" after 2 seconds
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy talent loadout code:', err);
    }
  };

  return (
    <button
      onClick={handleCopy}
      disabled={!text || text === 'No code found'}
      className={`text-xs px-3 py-1.5 rounded transition font-medium cursor-pointer shrink-0 min-w-[70px] text-center ${
        copied
          ? 'bg-emerald-600 text-emerald-50 border border-emerald-500 font-bold'
          : 'bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 hover:text-zinc-100 disabled:opacity-40 disabled:cursor-not-allowed'
      }`}
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}