'use client';

import { useRef, useState } from 'react';
import type { Timeline } from '../lib/analyzeRules';

// The cooldown timeline, drawn client-side so hovering a band or a bar shows an
// in-page card at once instead of the browser's delayed native tooltip. The numbers
// are all computed on the server; this file only draws them.

const ABILITY_ICON = (icon: string) => `https://assets.rpglogs.com/img/warcraft/abilities/${icon}`;
const fmtClock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
const ord = (k: number) => ['1st', '2nd', '3rd'][k] ?? `${k + 1}th`;
const isIntermission = (name: string) => /intermission|transition/i.test(name);
const VERDICT_COLOR = { good: '#86efac', warn: '#fcd34d', info: '#a1a1aa' } as const;

interface Hover { x: number; y: number; maxLeft: number; title: string; lines: string[]; tone: 'band' | 'on' | 'off' | 'none' | 'phase' }

export default function TimelineChart({ timeline }: { timeline: Timeline }) {
  const W = 760, LABEL = 200, PAD_R = 12, ROW = 34, AXIS = 22;
  const phases = (timeline.phases ?? []).filter(p => p.toSec > p.fromSec);
  const PHASE_H = phases.length ? 16 : 0;
  const TOP = 6 + PHASE_H;
  const plotW = W - LABEL - PAD_R;
  const dur = Math.max(1, timeline.durationSec);
  const x = (t: number) => LABEL + Math.min(1, Math.max(0, t / dur)) * plotW;
  const H = TOP + ROW * timeline.rows.length + AXIS;
  const step = dur <= 150 ? 30 : dur <= 480 ? 60 : 120;
  const ticks: number[] = [];
  for (let t = 0; t <= dur; t += step) ticks.push(t);
  const fit = (label: string, px: number) => { const max = Math.max(0, Math.floor(px / 5.6)); return label.length > max ? (max > 3 ? `${label.slice(0, max - 1)}…` : '') : label; };

  const box = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const show = (e: React.MouseEvent, h: Omit<Hover, 'x' | 'y' | 'maxLeft'>) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    setHover({ ...h, x: e.clientX - r.left, y: e.clientY - r.top, maxLeft: r.width - 240 });
  };
  // Functional update: a mousemove can fire right after a new element's mouseenter, and
  // a stale closure here would put the previous element's card back.
  const move = (e: React.MouseEvent) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    const x = e.clientX - r.left, y = e.clientY - r.top;
    setHover(h => (h ? { ...h, x, y } : h));
  };
  const hide = () => setHover(null);
  const toneColor = { band: '#fde68a', on: '#34d399', off: '#f59e0b', none: '#a1a1aa', phase: '#a1a1aa' } as const;

  return (
    <div ref={box} className="relative rounded-xl border border-zinc-800/70 bg-zinc-900/40 p-3 overflow-x-auto" onMouseMove={move} onMouseLeave={hide}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" className="block min-w-[560px]" role="img" aria-label="Cooldown timeline">
        {phases.map((p, i) => {
          const x0 = x(p.fromSec), x1 = x(Math.min(p.toSec, dur));
          const inter = isIntermission(p.name);
          const label = p.name.replace(/^(Stage|Phase) (One|Two|Three|Four|Five|\d+):\s*/i, m => m.replace(/:\s*$/, ' · ')).replace(/^Intermission:?\s*/i, 'Intermission · ');
          return (
            <g key={`${p.name}-${i}`}>
              <rect x={x0} y={6} width={Math.max(0, x1 - x0)} height={H - AXIS - 6} fill={inter ? '#f59e0b' : i % 2 ? '#ffffff' : '#000000'} opacity={inter ? 0.07 : i % 2 ? 0.03 : 0} />
              <line x1={x0} x2={x0} y1={6} y2={H - AXIS + 4} stroke={inter ? '#f59e0b' : '#3f3f46'} strokeWidth={1} opacity={inter ? 0.5 : 0.8} />
              <text x={x0 + 4} y={17} fill={inter ? '#fbbf24' : '#a1a1aa'} fontSize={9} fontFamily="var(--font-geist-mono), monospace" style={{ cursor: 'default' }}
                onMouseLeave={hide} onMouseEnter={e => show(e, { tone: 'phase', title: p.name, lines: [`${fmtClock(p.fromSec)} – ${fmtClock(p.toSec)}`] })}>
                {fit(label, x1 - x0 - 6)}
              </text>
            </g>
          );
        })}
        {ticks.map(t => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={TOP} y2={H - AXIS + 4} stroke="#27272a" strokeWidth={1} />
            <text x={x(t)} y={H - 6} fill="#71717a" fontSize={10} textAnchor="middle" fontFamily="var(--font-geist-mono), monospace">{fmtClock(t)}</text>
          </g>
        ))}
        {timeline.aliveSec < dur - 2 && (
          <g>
            <rect x={x(timeline.aliveSec)} y={TOP} width={Math.max(0, x(dur) - x(timeline.aliveSec))} height={H - AXIS - TOP} fill="#ef4444" opacity={0.06} />
            <line x1={x(timeline.aliveSec)} x2={x(timeline.aliveSec)} y1={TOP} y2={H - AXIS + 4} stroke="#ef4444" strokeWidth={1} strokeDasharray="3 3" opacity={0.7} />
          </g>
        )}
        {timeline.rows.map((row, i) => {
          const y = TOP + i * ROW;
          const firstBuff = row.kind === 'buff' && (i === 0 || timeline.rows[i - 1].kind !== 'buff');
          const bands = (row.bands ?? []).filter(b => b.med <= dur);
          const mine = row.mine.slice().sort((a, b) => a[0] - b[0]);
          return (
            <g key={row.name}>
              {i > 0 && <line x1={0} x2={W} y1={y} y2={y} stroke={firstBuff ? '#3f3f46' : '#18181b'} strokeWidth={1} strokeDasharray={firstBuff ? '4 3' : undefined} />}
              <a href={row.spellId ? `https://www.wowhead.com/spell=${row.spellId}` : undefined} target="_blank" rel="noopener noreferrer">
                {row.icon && <image href={ABILITY_ICON(row.icon)} x={6} y={y + 8} width={18} height={18} clipPath="inset(0 round 3px)" />}
                <text x={30} y={row.verdict ? y + 15 : y + ROW / 2 + 4} fill="#d4d4d8" fontSize={12} fontWeight={600} style={{ cursor: row.spellId ? 'pointer' : 'default' }}>
                  {row.name.length > 22 ? `${row.name.slice(0, 21)}…` : row.name}
                </text>
              </a>
              {row.verdict && (
                <text x={30} y={y + 27} fill={VERDICT_COLOR[row.verdict.kind]} fontSize={9.5} fontFamily="var(--font-geist-mono), monospace">
                  {row.verdict.text.length > 29 ? `${row.verdict.text.slice(0, 28)}…` : row.verdict.text}
                </text>
              )}
              {bands.map(b => (
                <g key={`b${b.k}`} style={{ cursor: 'default' }}
                  onMouseLeave={hide} onMouseEnter={e => show(e, { tone: 'band', title: `${row.name} · top players' ${ord(b.k)} press`, lines: [`Median ${fmtClock(b.med)}`, `Middle half of them: ${fmtClock(b.lo)} – ${fmtClock(b.hi)}`, `${row.poolN} players`] })}>
                  <rect x={x(b.lo)} y={y + 7} width={Math.max(4, x(Math.min(b.hi, dur)) - x(b.lo))} height={ROW - 14} rx={2} fill="#fde68a" opacity={0.14} />
                  <path d={`M ${x(b.med) - 4} ${y + 3} L ${x(b.med) + 4} ${y + 3} L ${x(b.med)} ${y + 9} Z`} fill="#fde68a" opacity={0.95} />
                  <rect x={x(b.lo) - 2} y={y + 1} width={Math.max(10, x(Math.min(b.hi, dur)) - x(b.lo) + 4)} height={ROW - 2} fill="transparent" />
                </g>
              ))}
              {mine.map(([s, e], j) => {
                const band = bands.find(b => b.k === j) ?? null;
                const diff = band ? s - band.med : null;
                const tol = band ? Math.max(20, band.hi - band.lo, 0.06 * band.med) : 0;
                const state: Hover['tone'] = diff == null ? 'none' : Math.abs(diff) <= tol ? 'on' : 'off';
                const lines = [`Pressed at ${fmtClock(s)}${e - s > 3.5 ? `, running until ${fmtClock(Math.min(e, dur))}` : ''}`];
                if (band && diff != null) lines.push(`${Math.round(Math.abs(diff))}s ${diff > 0 ? 'after' : 'before'} the top players' median (${fmtClock(band.med)})`, state === 'on' ? 'Inside their window' : 'Outside their window');
                else lines.push('No top-player window to judge this press by');
                return (
                  <rect key={j} x={x(s)} y={y + 11} width={Math.max(3, x(Math.min(e, dur)) - x(s))} height={ROW - 22} rx={2} fill={toneColor[state]} opacity={0.9} style={{ cursor: 'default' }}
                    onMouseLeave={hide} onMouseEnter={ev => show(ev, { tone: state, title: `${row.name} · your ${ord(j)} press`, lines })} />
                );
              })}
            </g>
          );
        })}
      </svg>
      {hover && (
        <div className="pointer-events-none absolute z-20 max-w-xs rounded-lg border border-zinc-700 bg-zinc-950/95 px-3 py-2 text-xs shadow-xl"
          style={{ left: Math.max(0, Math.min(hover.x + 12, hover.maxLeft)), top: hover.y + 14 }}>
          <p className="font-semibold text-zinc-100" style={{ color: toneColor[hover.tone] }}>{hover.title}</p>
          {hover.lines.map((l, i) => <p key={i} className="text-zinc-300 font-mono">{l}</p>)}
        </div>
      )}
    </div>
  );
}
