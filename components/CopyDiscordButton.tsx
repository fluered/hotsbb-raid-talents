'use client';
import { useRef, useState } from 'react';

// Copies a ready-made Discord message (built on the server, see lib/discordText.ts).
// The async clipboard API needs a secure context and permission; the hidden-textarea
// route covers the rest. State only ever changes from the click handler.
function legacyCopy(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  document.body.removeChild(ta);
  return ok;
}

export default function CopyDiscordButton({ text, className = '' }: { text: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = async () => {
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); ok = true; }
    } catch { ok = false; }
    if (!ok) ok = legacyCopy(text);
    setState(ok ? 'copied' : 'failed');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 2200);
  };

  const look = state === 'copied'
    ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
    : state === 'failed'
      ? 'bg-red-500/10 border-red-500/40 text-red-300'
      : 'border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700';
  return (
    <button
      type="button"
      onClick={handleCopy}
      data-copy-discord
      title="Copies a short text summary with a link to this page, formatted for a Discord message"
      className={`px-3 py-1.5 rounded-full text-xs font-bold transition-colors border whitespace-nowrap ${look} ${className}`}
    >
      <span aria-live="polite">{state === 'copied' ? 'Copied' : state === 'failed' ? 'Could not copy' : 'Copy for Discord'}</span>
    </button>
  );
}
