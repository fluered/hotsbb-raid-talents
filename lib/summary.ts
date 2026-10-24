// ─── The short version ─────────────────────────────────────────────────────────
//
// One paragraph at the top of a review, built the same way for a raid and for a
// player: a verdict sentence from the comparison data, then the one or two things
// that cost the most, then one strength. Items are ranked by a single cost figure so
// a death outranks a mechanic, a mechanic worse than the top raids outranks a
// consumable, and a clean pull gets the verdict and the strength with no nitpicks
// dressed up as "the things that cost the raid most".

import type { Severity } from './analyzeRules';

export interface SummaryItem {
  severity: Severity;
  // A clause that reads after "The thing that cost most:" — no trailing full stop.
  brief: string;
  // Higher costs more. Problems rank by cost descending, strengths ascending.
  cost: number;
}

// Cost of a review finding by category, when nothing more specific is known.
const CATEGORY_COST: Record<string, number> = {
  survival: 6, mechanics: 4, cooldowns: 3, output: 2.5, rotation: 2.5, uptime: 2, prep: 1.5, gear: 1, buffs: 1, utility: 0.5, build: 0.3,
};
export function costOf(category: string, severity: Severity): number {
  const base = CATEGORY_COST[category] ?? 1;
  return severity === 'bad' ? base * 2 : severity === 'warn' ? base : severity === 'good' ? -base : 0;
}

export function composeSummary(opts: { verdict: string; problems: SummaryItem[]; strengths: SummaryItem[]; subject: 'raid' | 'you' }): string {
  const problems = opts.problems.filter(p => p.severity === 'bad' || p.severity === 'warn').sort((a, b) => b.cost - a.cost);
  const strengths = opts.strengths.filter(s => s.severity === 'good').sort((a, b) => a.cost - b.cost);
  const parts: string[] = [opts.verdict.trim().replace(/\.?$/, '.')];
  // Two clauses about the same thing (the deaths, and the deaths with a defensive up)
  // say one thing twice: the second pick must not share the first one's subject.
  const subjectOf = (b: string) => (/death|died|wipe/i.test(b) ? 'deaths' : b.split(/[:,]| hit | did | took /)[0].trim().toLowerCase());
  const picked: SummaryItem[] = [];
  for (const p of problems) {
    if (picked.length >= 2) break;
    if (picked.some(q => subjectOf(q.brief) === subjectOf(p.brief) || q.brief.toLowerCase().includes(subjectOf(p.brief)))) continue;
    picked.push(p);
  }
  const top = picked.map(p => p.brief.trim().replace(/\.$/, ''));
  if (top.length === 0) parts.push(opts.subject === 'raid' ? 'Nothing here the raid needs to change.' : 'Nothing here you need to change.');
  else if (top.length === 1) parts.push(`The one thing that mattered: ${top[0]}.`);
  else parts.push(`The two things that mattered most: ${top[0]}; and ${top[1]}.`);
  if (strengths[0]) parts.push(`On the plus side: ${strengths[0].brief.trim().replace(/\.$/, '').replace(/^You /, 'you ')}.`);
  return parts.join(' ');
}

// "35 seconds slower than the top raids' median" / "on the top raids' pace".
export function paceClause(durationSec: number, topMedianSec: number | null, who = 'the top raids'): string {
  if (!topMedianSec || topMedianSec <= 0) return '';
  const diff = Math.round(durationSec - topMedianSec);
  if (Math.abs(diff) <= 10) return `on ${who}' pace`;
  const abs = Math.abs(diff);
  const span = abs >= 60 ? `${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, '0')}` : `${abs} seconds`;
  return `${span} ${diff > 0 ? 'slower' : 'faster'} than ${who}' median kill`;
}
