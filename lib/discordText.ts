// ─── Copy for Discord ──────────────────────────────────────────────────────────
//
// A review as one Discord message: bold headings, short lines, no tables, no
// mentions or timestamps, the page's link last. Pure functions over the review
// objects the page already builds, so the text can never say something the page
// does not. Lines are dropped from the bottom until the message fits.

import type { Finding, Review } from './analyzeRules';
import type { RaidItem, RaidReview } from './raidReview';
import type { NightReview } from './nightReview';
import type { PlayerNight } from './playerNight';
import { costOf } from './summary';

export const DISCORD_MAX = 1800;
export const SITE_ORIGIN = 'https://hotsbbtalents.io';

interface FightLike { name: string; kill: boolean; fightPercentage: number; durationMs: number; difficulty: number }
interface PlayerLike { name: string; spec: string; className: string }

const DIFFICULTY: Record<number, string> = { 1: 'LFR', 2: 'Flex', 3: 'Normal', 4: 'Heroic', 5: 'Mythic' };
const clock = (sec: number) => { const s = Math.max(0, Math.round(sec)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

// Names and titles go in as plain text: markdown characters are escaped, and an @ can
// never start a mention.
export function plain(s: string): string {
  return s.replace(/([\\*_~`|])/g, '\\$1').replace(/@/g, '@\u200b').replace(/\s+/g, ' ').trim();
}

export function analyzeUrl(params: Record<string, string | number | null | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') qs.set(k, String(v));
  return `${SITE_ORIGIN}/analyze?${qs.toString()}`;
}

// Head lines are always kept; body lines go from the bottom up when the message is too
// long, and a heading left with nothing under it goes with them.
export function fitMessage(head: string[], body: string[], url: string, max = DISCORD_MAX): string {
  const lines = body.slice();
  const render = () => [...head, ...lines, url].join('\n');
  const isHeading = (l: string | undefined) => !!l && /^\*\*.*\*\*$/.test(l);
  // Windows puts a carriage return on every line when the text reaches the clipboard,
  // so each line break is counted as two characters.
  const size = (t: string) => t.length + (t.match(/\n/g)?.length ?? 0);
  while (lines.length && size(render()) > max) {
    lines.pop();
    while (lines.length && (isHeading(lines[lines.length - 1]) || lines[lines.length - 1] === '')) lines.pop();
  }
  let text = render();
  if (size(text) > max) {
    // The head alone is too long (a very long summary): trim it at a word.
    const room = max - url.length - 2 - head.length;
    const cut = head.join('\n').slice(0, room);
    text = `${cut.slice(0, Math.max(cut.lastIndexOf(' '), room - 80))}…\n${url}`;
  }
  return text;
}

const bullet = (s: string) => `• ${s}`;
const names = (rows: Array<{ name: string }>, max: number) => {
  const shown = rows.slice(0, max).map(r => plain(r.name)).join(', ');
  return rows.length > max ? `${shown} +${rows.length - max}` : shown;
};
const pullLine = (fight: FightLike) => `${DIFFICULTY[fight.difficulty] ?? ''} ${fight.kill ? 'kill' : `wipe at ${Math.round(fight.fightPercentage)}%`} · ${clock(fight.durationMs / 1000)}`.trim();
const bySeverity = <T extends { severity: string; impact: number; cost?: number }>(xs: T[]) =>
  xs.slice().sort((a, b) => (a.severity === 'bad' ? 0 : 1) - (b.severity === 'bad' ? 0 : 1) || (b.cost ?? 0) - (a.cost ?? 0) || b.impact - a.impact);

// ── One pull, the whole raid ──
export function raidDiscordText(review: RaidReview, fight: FightLike, url: string): string {
  const head = [`**${plain(fight.name)} · ${pullLine(fight)}**`, plain(review.summary)];
  const body: string[] = [];
  const wipes = review.items.filter(i => i.id.startsWith('wipe-'));
  const deaths = review.items.find(i => i.id === 'deaths');
  if (wipes.length || deaths) {
    body.push('', '**Deaths**');
    for (const w of wipes.slice(0, 2)) body.push(bullet(plain(w.title)));
    // Row values read "2× · 1:05 Ability, 3:40 Other": the count is dropped for one death.
    for (const r of (deaths?.rows ?? []).slice(0, 6)) body.push(bullet(`${plain(r.name)}: ${plain(r.value.replace(/^1× · /, ''))}`));
    if ((deaths?.rows.length ?? 0) > 6) body.push(bullet(`and ${deaths!.rows.length - 6} more`));
  }
  const mech = bySeverity(review.items.filter(i => (i.group === 'boss' || i.group === 'mechanics') && (i.severity === 'bad' || i.severity === 'warn'))).slice(0, 4);
  if (mech.length) {
    body.push('', '**Mechanics that cost most**');
    for (const m of mech) body.push(bullet(`${plain(m.title)}${worst(m)}`));
  }
  const prep = review.items.filter(i => i.group === 'prep' && (i.severity === 'bad' || i.severity === 'warn') && i.rows.length);
  if (prep.length) {
    body.push('', '**Consumables**');
    for (const p of prep.slice(0, 4)) body.push(bullet(`${plain(p.title)}. Missing: ${names(p.rows, 8)}`));
  }
  return fitMessage(head, body, url);
}

// " (worst: A, B, C)" for a card whose rows are players.
function worst(item: RaidItem): string {
  const rows = item.rows.filter(r => r.id != null);
  if (!rows.length || item.rowsLabel === 'applications' || item.rowsLabel === 'entries') return '';
  const seen = new Set<string>();
  const uniq = rows.filter(r => !seen.has(r.name) && seen.add(r.name));
  return ` (${names(uniq, 3)})`;
}

// ── One player ──
export function playerDiscordText(review: Review, mechanics: RaidItem[], player: PlayerLike, fight: FightLike, url: string): string {
  const head = [`**${plain(player.name)} · ${plain(`${player.spec} ${player.className}`)} · ${plain(fight.name)} (${pullLine(fight)})**`, plain(review.summary)];
  const body: string[] = [];
  // The plan for the next pull leads (lib/nextPull.ts): numbered instructions with the
  // buttons in bold, each with its line of evidence.
  const plan = review.nextPull;
  if (plan.actions.length || plan.clean) {
    const esc = (s: string) => s.replace(/([\\*_~`|])/g, '\\$1').replace(/@/g, '@\u200b');
    body.push('', '**Next pull**');
    if (plan.clean) body.push(plain(plan.clean));
    plan.actions.forEach((a, i) => {
      body.push(`${i + 1}. ${a.parts.map(p => (p.t === 'spell' ? `**${plain(p.name)}**` : esc(p.v))).join('')}`);
      if (a.evidence) body.push(`↳ ${plain(a.evidence)}`);
    });
  }
  // Ranked the way the short version ranks them (lib/summary.ts): a finding's own cost,
  // else its category's; a mechanic card's cost, else 2.
  type Entry = { id: string; severity: Finding['severity']; title: string; impact: number; cost: number };
  const all: Entry[] = [
    ...review.findings.filter(f => f.id !== 'output').map(f => ({ id: f.id, severity: f.severity, title: f.title, impact: f.impact, cost: f.cost ?? Math.abs(costOf(f.category, f.severity)) })),
    ...mechanics.map(m => ({ id: m.id, severity: m.severity, title: m.title, impact: m.impact, cost: m.cost ?? 2 })),
  ];
  const problems = all.filter(e => e.severity === 'bad' || e.severity === 'warn');
  const fixes = problems.slice().sort((a, b) => b.cost - a.cost || b.impact - a.impact).slice(0, 3);
  if (fixes.length) {
    body.push('', review.strong && !problems.some(e => e.severity === 'bad') ? '**Smaller things**' : '**Fix first**');
    for (const f of fixes) body.push(bullet(plain(f.title)));
  }
  const pref = (e: Entry) => (e.id === 'timing-good' ? 0 : e.id === 'clean-mechanics' ? 1 : 2);
  const good = all.filter(e => e.severity === 'good').sort((a, b) => pref(a) - pref(b) || b.impact - a.impact)[0];
  if (good) body.push('', '**Went right**', bullet(plain(good.title)));
  return fitMessage(head, body, url);
}

// ── A night on one boss ──
export function nightDiscordText(night: NightReview, url: string): string {
  const kills = night.pulls.filter(p => p.kill).length;
  const head = [
    `**${plain(night.bossName)} · ${DIFFICULTY[night.difficulty] ?? ''} · night summary**`,
    plain(night.summary),
    night.stats.filter(s => s.value !== '—').map(s => `${s.label} **${plain(s.value)}**`).join(' · '),
  ];
  const body: string[] = [];
  // First after the short version, so it is the last thing the length cap can take.
  if (night.nextPull.steps.length || night.nextPull.working) {
    body.push('', '**Before the next pull**');
    night.nextPull.steps.forEach((s, i) => body.push(`${i + 1}. **${plain(s.text)}** ${plain(s.evidence)}`));
    if (night.nextPull.working) body.push(bullet(`Already working: ${plain(night.nextPull.working)}`));
  }
  if (night.wipeCauses.length) {
    body.push('', '**What wiped the raid**');
    for (const w of night.wipeCauses.slice(0, 3)) body.push(bullet(`${plain(w.name)}: ${w.pulls} of ${night.pulls.length - kills} wipes`));
  }
  if (night.killers.length) {
    body.push('', '**What killed people before the wipes**');
    for (const k of night.killers.slice(0, 4)) {
      const who = k.players.slice(0, 3).map(p => `${plain(p.name)}${p.count > 1 ? ` ×${p.count}` : ''}`).join(', ');
      body.push(bullet(`${plain(k.name)}: ${k.pulls} of ${night.pulls.length} pulls, ${k.deaths} death${k.deaths === 1 ? '' : 's'} (${who}${k.players.length > 3 ? ` +${k.players.length - 3}` : ''})`));
    }
  }
  // Major defensives only: a short-cooldown button being ready is not a line worth posting.
  const ready = (night.readyDeaths?.players ?? []).filter(p => p.withMajor > 0);
  if (night.readyDeaths && ready.length) {
    body.push('', `**Died with a major defensive ready (${night.readyDeaths.withMajor} of ${night.readyDeaths.judged} deaths)**`);
    for (const p of ready.slice(0, 5)) body.push(bullet(`${plain(p.name)}: ${p.withMajor} of ${p.deaths} (${p.major.slice(0, 2).map(r => plain(r.name)).join(', ')})`));
  }
  const firsts = night.firstDeaths.filter(f => f.count >= 2).slice(0, 4);
  if (firsts.length) body.push('', '**First to die**', bullet(firsts.map(f => `${plain(f.name)} ×${f.count}`).join(', ')));
  const mechs = night.mechanics.filter(m => m.players.length && !m.assigned && !m.raidWide).slice(0, 4);
  if (mechs.length) {
    body.push('', '**Repeat offenders**');
    for (const m of mechs) body.push(bullet(`${plain(m.name)}: ${m.players.slice(0, 3).map(p => `${plain(p.name)} ${p.times}×`).join(', ')}`));
  }
  const h = night.healing;
  if (h) {
    const stones = h.warlockPulls === 0 && h.healthstone.uses === 0 ? 'no Warlock, so no healthstones' : `healthstones on ${h.healthstone.pulls} of ${h.pulls} pulls (${h.healthstone.players} of ${h.players.length} players)`;
    body.push('', '**Healthstones and potions**', bullet(`${stones}; healing potions on ${h.potion.pulls} of ${h.pulls} (${h.potion.players} of ${h.players.length})`));
  }
  return fitMessage(head, body, url);
}

// ── One player's night on one boss ──
export function playerNightDiscordText(pn: PlayerNight, url: string): string {
  const head = [
    `**${plain(pn.player.name)} · ${plain(pn.bossName)} · ${DIFFICULTY[pn.difficulty] ?? ''} · their night**`,
    plain(pn.summary),
    pn.stats.filter(s => s.value !== '—').map(s => `${s.label} **${plain(s.value)}**`).join(' · '),
  ];
  const body: string[] = [];
  if (pn.nextPull.length) {
    body.push('', '**Before your next pull**');
    pn.nextPull.forEach((s, i) => body.push(`${i + 1}. **${plain(s.text)}** ${plain(s.evidence)}`));
  }
  const died = pn.pulls.filter(p => p.present && p.death?.counted);
  if (died.length) {
    body.push('', '**Deaths before the wipes**');
    for (const p of died.slice(0, 6)) body.push(bullet(`Pull ${p.n}: ${p.death!.first ? 'first, ' : ''}${clock(p.death!.atSec)} to ${plain(p.death!.killer)}${p.death!.major.length ? ` (${p.death!.major.map(plain).join(', ')} ready)` : ''}`));
    if (died.length > 6) body.push(bullet(`and ${died.length - 6} more`));
  }
  const mechs = pn.mechanics.filter(m => !m.assigned).slice(0, 4);
  if (mechs.length) {
    body.push('', '**Avoidable hits**');
    for (const m of mechs) body.push(bullet(`${plain(m.name)}: ${m.times}× over ${m.pulls} pull${m.pulls === 1 ? '' : 's'}`));
  }
  const worse = pn.compare.filter(c => c.verdict && c.median);
  if (worse.length) {
    body.push('', '**Against the median player**');
    for (const c of worse) body.push(bullet(`${c.label}: ${plain(c.value)} (median ${plain(c.median!)})`));
  }
  if (pn.bestWorst) body.push('', bullet(plain(pn.bestWorst.text)));
  return fitMessage(head, body, url);
}
