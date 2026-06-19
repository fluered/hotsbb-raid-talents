'use client';
import { useState } from 'react';

export default function CopyBuildButton({ talentString }: { talentString: string | null }) {
  const [copied, setCopied] = useState(false);

  if (!talentString) return null;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(talentString);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className={`px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wider transition-all border ${
        copied
          ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400'
          : 'bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100'
      }`}
    >
      {copied ? 'Copied!' : 'Copy Build'}
    </button>
  );
}
