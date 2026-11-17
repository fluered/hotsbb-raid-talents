// Mechanics audit: what the site takes every boss ability to be, and where to look twice.
//
// The Log Review tells players what to do about an ability (step out of it, press a
// defensive, pick up the fight's own protection). That advice rests on typing the ability
// from three sources: the boss addons' warnings, the dungeon journal's wording and the
// top raids' logs. This prints, per boss, every ability with each source's reading and
// the final one, and marks:
//
//   CONFLICT  two sources disagree on whether the damage is meant to be taken
//   UNREAD    no source could type it, and its journal text hints at a mechanic; the site
//             gives no advice for it until someone looks
//   WARD      the fight answers it with another ability (never a defensive)
//
// Run it when a raid opens, after a patch, and whenever a review says something odd:
//
//   node scripts/mechanics-audit.mjs                 (needs `next dev -p 3111` running)
//   node scripts/mechanics-audit.mjs --all           every ability, not only the marked ones
//   node scripts/mechanics-audit.mjs --boss kithix --difficulty 4
//
// Costs nothing at Warcraft Logs.

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args.splice(i, 2)[1] : fallback; };
const base = opt('base', 'http://localhost:3111');
const difficulty = opt('difficulty', '5');
const only = opt('boss', null);
const all = args.includes('--all');

const r = await fetch(`${base}/api/debug-mechanics?difficulty=${difficulty}`, { headers: { 'x-hbt-internal': 'hotsbb-export-script' } });
if (!r.ok) { console.error(`audit route answered ${r.status}`); process.exit(1); }
const { bosses } = await r.json();
let marked = 0;
for (const b of bosses) {
  if (only && b.slug !== only) continue;
  if (b.error) { console.log(`\n== ${b.boss}: ${b.error}`); continue; }
  const src = [b.sources.dbm ? 'addons' : null, b.sources.journal ? 'journal' : null, b.raidStatKills ? `${b.raidStatKills} top kills` : null].filter(Boolean).join(', ') || 'no sources';
  const rows = b.abilities.filter(a => all || a.flags.length);
  marked += b.abilities.filter(a => a.flags.some(f => f !== 'ward')).length;
  console.log(`\n== ${b.boss} (${src}; ${b.abilities.length} abilities, ${b.abilities.filter(a => !a.final && !a.ward).length} untyped)`);
  for (const a of rows) {
    const flags = a.flags.map(f => f.toUpperCase()).join(' ');
    console.log(`  ${flags.padEnd(9)} ${a.name}: ${a.ward ? `answered by ${a.ward}` : a.final ? `${a.final} (${a.via})` : 'untyped'}`);
    console.log(`            addons ${a.dbm ?? '-'} · journal ${a.journal ? `${a.journal} ${a.journalWhy}` : '-'} · logs ${a.logsShare == null ? '-' : `${a.logsShare}% of players hit${a.logs ? ` → ${a.logs}` : ''}`}`);
    if (a.flags.length && a.text) console.log(`            "${a.text}"`);
  }
  if (!rows.length) console.log('  nothing marked');
}
console.log(`\n${marked} ${marked === 1 ? 'ability needs' : 'abilities need'} a look (CONFLICT or UNREAD).`);
