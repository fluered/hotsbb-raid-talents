import type { Metadata } from 'next';
import { getWclToken } from './wow';
import { parseReportInput, getReportOverview, getFightPlayers, DIFFICULTY_LABELS, type ReportFight } from './analyze';
import { pickNightGroup } from './nightReview';
import { ogImageMeta } from './ogImage';

// Title, description and share card for a Log Review link, so a link pasted into
// Discord unfurls with the headline: which boss, kill or wipe, whose review.
//
// This runs on EVERY request for the URL, including each chat app's link-preview
// crawler, so it is held to the two cheapest loaders the page has:
//   - getReportOverview: one WCL request, cached 300 s, which the page needs anyway;
//   - getFightPlayers: one WCL request, cached a day, only when the link names a player
//     (the page needs it for that state too).
// Never a pool, never a review. Anything that fails or takes too long gives the
// generic card: a share image is not worth a slow or broken <head>.
//
// Every name on the card comes from Warcraft Logs' data for the report (its title, the
// encounter's name, the character's name), never from the URL's own text.

export interface AnalyzeSearchParams {
  report?: string;
  fight?: string;
  player?: string;
  view?: string;
  boss?: string;
  difficulty?: string;
  debug?: string;
}

const META_TIMEOUT_MS = 4000;
const ROBOTS = { index: false, follow: false } as const;

function clock(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const outcome = (f: ReportFight) => (f.kill ? 'kill' : `wipe at ${Math.round(f.fightPercentage)}%`);
// "Mythic kill in 4:04" / "Heroic wipe at 34% after 3:10".
const pullLine = (f: ReportFight) =>
  `${DIFFICULTY_LABELS[f.difficulty] ?? ''} ${f.kill ? `kill in ${clock(f.durationMs)}` : `wipe at ${Math.round(f.fightPercentage)}% after ${clock(f.durationMs)}`}`.trim();

interface Card { title: string; description: string; imageTitle: string; subtitle: string; kicker: string; className?: string }

function toMetadata(c: Card): Metadata {
  return {
    title: c.title,
    description: c.description,
    robots: ROBOTS,
    ...ogImageMeta({ title: c.title, description: c.description, imageTitle: cut(c.imageTitle, 60), subtitle: cut(c.subtitle, 120), kicker: c.kicker, className: c.className }),
  };
}

const GENERIC: Card = {
  title: 'Log Review (preview) | HotsBB',
  description: 'Paste a Warcraft Logs report and get a plain-English read on what went right and wrong in your pull.',
  imageTitle: 'Log Review',
  subtitle: 'Paste a Warcraft Logs report: what went right and wrong in your pull, in plain English',
  kicker: 'Preview',
};

async function resolveCard(sp: AnalyzeSearchParams): Promise<Card> {
  const raw = sp.report ?? '';
  const ref = raw ? parseReportInput(raw) : null;
  if (!ref) return GENERIC;

  const token = await getWclToken();
  const overview = await getReportOverview(token, ref.code);
  if (!overview) return GENERIC;

  // A pasted Warcraft Logs URL carries its own #fight / #source; the page redirects to
  // the clean form with the same precedence.
  const pasted = raw !== ref.code;
  const fightParam = pasted && ref.fightId != null ? String(ref.fightId) : sp.fight;
  const playerParam = pasted && ref.sourceId != null ? String(ref.sourceId) : sp.player;
  const fight = fightParam === 'last'
    ? overview.fights[overview.fights.length - 1]
    : fightParam ? overview.fights.find(f => f.id === parseInt(fightParam)) : undefined;
  const report = cut(overview.title, 60);

  if (!fight) {
    const night = sp.view === 'night' ? pickNightGroup(overview, sp.boss, sp.difficulty) : null;
    if (night && night.fights.length >= 2) {
      const diff = DIFFICULTY_LABELS[night.difficulty] ?? '';
      const killAt = night.fights.findIndex(f => f.kill);
      const best = Math.round(Math.min(...night.fights.map(f => f.fightPercentage)));
      const result = killAt >= 0 ? `killed on pull ${killAt + 1}` : `best pull ${best}%`;
      const line = `${diff} · ${plural(night.fights.length, 'pull')} · ${result}`;
      return {
        title: `${night.name} night summary: ${plural(night.fights.length, 'pull')}, ${result} | HotsBB Log Review`,
        description: `${diff} ${night.name}, ${plural(night.fights.length, 'pull')} in "${report}": ${result}. What wiped the raid, pull by pull, and who died to what.`,
        imageTitle: night.name,
        subtitle: `${line} · what wiped the raid`,
        kicker: 'Log Review · Night summary',
      };
    }
    const n = overview.fights.length;
    const bosses = [...new Set(overview.fights.map(f => f.name))];
    const kills = overview.fights.filter(f => f.kill).length;
    const bossLine = bosses.length ? `${bosses.slice(0, 3).join(', ')}${bosses.length > 3 ? ` and ${bosses.length - 3} more` : ''}` : '';
    const counts = `${plural(n, 'boss pull')}${kills ? `, ${plural(kills, 'kill')}` : ''}`;
    return {
      title: `${report}: ${plural(n, 'boss pull')} | HotsBB Log Review`,
      description: `${counts}${bossLine ? ` on ${bossLine}` : ''}. Pick a pull for the raid summary, or a player for a personal review.`,
      imageTitle: report,
      subtitle: `${counts}${bossLine ? ` · ${bossLine}` : ''}`,
      kicker: 'Log Review',
    };
  }

  const pull = pullLine(fight);
  const playerId = playerParam && /^\d+$/.test(playerParam) ? parseInt(playerParam) : null;
  if (playerId != null) {
    const player = (await getFightPlayers(token, overview.code, fight.id)).find(p => p.id === playerId);
    if (player) {
      const who = `${player.spec} ${player.className}`.trim();
      return {
        title: `${player.name} (${who}) on ${fight.name}: ${DIFFICULTY_LABELS[fight.difficulty] ?? ''} ${outcome(fight)} | HotsBB Log Review`,
        description: `${player.name}'s ${who} review for ${fight.name}, ${pull}: what went right, what went wrong, measured against the top players of the spec.`,
        imageTitle: player.name,
        subtitle: `${who} · ${fight.name} · ${pull}`,
        kicker: 'Log Review · Player review',
        className: player.className,
      };
    }
  }

  const players = sp.view === 'players';
  return {
    title: `${fight.name}: ${DIFFICULTY_LABELS[fight.difficulty] ?? ''} ${outcome(fight)}, ${clock(fight.durationMs)} | HotsBB Log Review`,
    description: players
      ? `${fight.name}, ${pull}, from "${report}". Pick a player for a personal review.`
      : `Raid summary of ${fight.name}, ${pull}, from "${report}": who died to what, which mechanics were failed and by whom.`,
    imageTitle: fight.name,
    subtitle: `${pull} · ${players ? 'player reviews' : 'who died to what, which mechanics failed'}`,
    kicker: players ? 'Log Review · Players' : 'Log Review · Raid summary',
  };
}

export async function analyzeMetadata(sp: AnalyzeSearchParams): Promise<Metadata> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const card = await Promise.race([
      resolveCard(sp),
      new Promise<Card>(resolve => { timer = setTimeout(() => resolve(GENERIC), META_TIMEOUT_MS); }),
    ]);
    return toMetadata(card);
  } catch {
    return toMetadata(GENERIC);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
