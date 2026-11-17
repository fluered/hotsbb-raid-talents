import { NextRequest } from 'next/server';
import { getBossSources, getRaidBosses } from '../../../lib/bossPage';
import { JOURNAL_HINTS, lookupLabel, normalizeName, readJournal, wardFor, type MechanicType } from '../../../lib/bossMechanics';
import { classifyAbility, median } from '../../../lib/analyzeRules';
import { isAuthorizedInternalCaller } from '../../../lib/internalAuth';

// The mechanics audit: every ability of every boss with what each source says it is (the
// boss addons, the dungeon journal's wording, the top raids' logs), what the site ends up
// calling it, and a flag where that deserves a look:
//
//   conflict  two sources disagree on whether the damage is meant to be taken
//   unread    damage no source could type, whose journal text hints at a mechanic
//             ("unless", "removes", "immune", …): the site gives no advice for it
//   ward      the fight answers it with another of its abilities (never a defensive)
//
// Read by scripts/mechanics-audit.mjs. Run it when a raid opens and after a patch: this
// is how a wrong reading is found before a player finds it in their review.
// Costs nothing at Warcraft Logs: the logs' part is read from what is already cached.

const TAKEN: MechanicType[] = ['raidwide', 'defensive', 'soak', 'gather', 'tank', 'targeted', 'debuff'];
const DODGED: MechanicType[] = ['avoid', 'spread', 'fixate'];
const side = (t: MechanicType | null | undefined) => (t && TAKEN.includes(t) ? 'taken' : t && DODGED.includes(t) ? 'dodged' : null);

export async function GET(request: NextRequest) {
  if (process.env.NODE_ENV === 'production' && !isAuthorizedInternalCaller(request)) {
    return Response.json({ status: 'forbidden' }, { status: 403 });
  }
  const difficulty = parseInt(new URL(request.url).searchParams.get('difficulty') ?? '5');
  const bosses = await getRaidBosses();
  const out = [];
  for (const boss of bosses) {
    try {
      const { knowledge: k, raidStats } = await getBossSources(boss, difficulty);
      const bossKey = normalizeName(boss.name);
      const foreign = new Set(k.labels.filter(l => normalizeName(l.boss) !== bossKey && l.name).map(l => normalizeName(l.name)));
      const names = new Map<string, { name: string; spellId: number }>();
      for (const j of k.journal) if (j.name && !foreign.has(normalizeName(j.name))) names.set(normalizeName(j.name), { name: j.name, spellId: j.spellId });
      for (const [name, a] of Object.entries(raidStats?.abilities ?? {})) if (!names.has(normalizeName(name))) names.set(normalizeName(name), { name, spellId: a.spellId });
      const abilities = [...names.values()].map(({ name, spellId }) => {
        const label = lookupLabel(k, name, spellId);
        const read = readJournal(k, name, spellId);
        const rs = raidStats?.abilities[name];
        const share = rs && rs.share.length >= 2 ? median(rs.share) : null;
        const tankShare = rs && rs.share.length >= 2 ? median(rs.tankShare) : null;
        const logs: MechanicType | null = share == null ? null : tankShare != null && tankShare >= 0.9 && share <= 0.25 ? 'tank' : share >= 0.6 ? 'raidwide' : share <= 0.05 ? 'avoid' : null;
        const final = classifyAbility(k, raidStats, name, spellId);
        const ward = wardFor(k, name, spellId);
        const text = k.journal.find(j => normalizeName(j.name) === normalizeName(name))?.description ?? '';
        // A cleave aimed at the tank is a dodge for the raid and a hit for the tank: no conflict.
        const sides = [...new Set([side(label?.type), side(read?.type), logs === 'tank' ? null : side(logs)].filter(Boolean))];
        const flags = [
          ...(sides.length > 1 && final?.via !== 'ruling' ? ['conflict'] : []),
          ...(!final && !ward && /\binflict/i.test(text) && JOURNAL_HINTS.test(text) ? ['unread'] : []),
          ...(ward ? ['ward'] : []),
        ];
        return {
          name, spellId, dbm: label && label.type !== 'unknown' ? label.type : null,
          journal: read?.type ?? null, journalWhy: read?.why ?? null,
          logsShare: share == null ? null : Math.round(share * 100), logs,
          final: final?.type ?? null, via: final?.via ?? null,
          ward: ward ? `${ward.name}${ward.pct ? ` (${ward.pct}% off)` : ''}` : null,
          flags, text: text.slice(0, 240),
        };
      });
      out.push({ boss: boss.name, slug: boss.slug, sources: k.sources, raidStatKills: raidStats?.n ?? 0, abilities });
    } catch (err) {
      out.push({ boss: boss.name, slug: boss.slug, error: String(err) });
    }
  }
  return Response.json({ difficulty, bosses: out });
}
