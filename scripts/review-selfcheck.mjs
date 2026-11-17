// Leave-one-out self-check for the Log Review rules (lib/analyzeRules.ts, lib/roleRules.ts).
//
// The rules compare a player with the top-ranked players of their spec on a boss. A rule
// that then flags those top players themselves is wrong or too tight, so this takes a few
// of them straight from the rankings, runs each one's review on a local dev server (where
// reviewPlayer leaves the reviewed parse out of its own pool) and lists every `bad` and
// `warn` finding they get. Top players should come out clean, or nearly so.
// It also prints each player's "Next pull" plan (lib/nextPull.ts): for a top player that
// should be "nothing to change" or prep, never a list of things to do differently.
// --plan-debug adds every candidate action and the damage moments behind the defensive plan.
//
//   node --env-file=.env.local scripts/review-selfcheck.mjs 3470:Paladin:Retribution 3492:Warrior:Protection 3470:Shaman:Restoration:hps
//   node --env-file=.env.local scripts/review-selfcheck.mjs --ranks 1,5,20 --difficulty 5 3470:Mage:Arcane
//   node scripts/review-selfcheck.mjs --url "/analyze?report=CODE&fight=3&player=8"      (any review, no rankings lookup)
//
// Specs are encounterId:Class:Spec[:hps] in Warcraft Logs' spelling (DeathKnight, BeastMastery);
// add :hps for healers. Needs `next dev` running (--base, default http://localhost:3111): the
// page only prints its debug dump outside production. Costs a rankings page and a
// playerDetails call per spec, plus whatever the reviews themselves fetch (a spec's first
// review builds its pool, about 50 points).

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args.splice(i, 2)[1] : fallback; };
const base = opt('base', 'http://localhost:3111');
const ranks = opt('ranks', '1,3,12').split(',').map(Number).filter(n => n > 0);
const difficulty = Number(opt('difficulty', '5'));
const planDebug = (i => (i >= 0 ? (args.splice(i, 1), true) : false))(args.indexOf('--plan-debug'));
// One group per spec (and per --url): groups run side by side, a group's reviews one after
// another, so a spec's pool is built once and not once per review.
const groups = [];
for (let u; (u = opt('url', null)); ) groups.push([{ label: u, url: u }]);

let token;
async function wcl(query) {
  if (!token) {
    const auth = Buffer.from(`${process.env.WCL_CLIENT_ID}:${process.env.WCL_CLIENT_SECRET}`).toString('base64');
    const r = await fetch('https://www.warcraftlogs.com/oauth/token', { method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
    token = (await r.json()).access_token;
    if (!token) throw new Error('No Warcraft Logs token: run with --env-file=.env.local');
  }
  const r = await fetch('https://www.warcraftlogs.com/api/v2/client', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 300));
  return j.data;
}

for (const spec of args) {
  const [enc, cls, name, metric] = spec.split(':');
  const d = await wcl(`{ worldData { encounter(id: ${Number(enc)}) { characterRankings(className: "${cls}", specName: "${name}", difficulty: ${difficulty}${metric ? `, metric: ${metric}` : ''}) } } }`);
  const rows = (d.worldData?.encounter?.characterRankings?.rankings ?? []).filter(r => r.report?.code && r.report?.fightID);
  const picks = ranks.map(n => ({ rank: n, row: rows[n - 1] })).filter(x => x.row);
  if (!picks.length) { console.log(`${spec}: no rankings`); continue; }
  const pd = await wcl(`{ reportData { ${picks.map((p, i) => `r${i}: report(code: "${p.row.report.code}") { playerDetails(fightIDs: [${p.row.report.fightID}]) }`).join(' ')} } }`);
  const group = [];
  groups.push(group);
  picks.forEach((p, i) => {
    const det = pd.reportData?.[`r${i}`]?.playerDetails?.data?.playerDetails;
    const all = det ? [...(det.tanks ?? []), ...(det.healers ?? []), ...(det.dps ?? [])] : [];
    const me = all.find(x => x.name === p.row.name && x.type === cls) ?? all.find(x => x.name === p.row.name);
    if (me) group.push({ label: `${name} ${cls} #${p.rank}`, url: `/analyze?report=${p.row.report.code}&fight=${p.row.report.fightID}&player=${me.id}` });
  });
}

const unescape = s => s.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
// The review's debug dump, from the page's ?debug=1 <pre>. A cold review can run past the
// page's time budget and come back as its loading state: ask again a few times.
async function debugOf(url) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const html = await fetch(`${base}${url}&debug=1`).then(r => r.text()).catch(() => '');
    for (const m of html.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/g)) {
      try { const j = JSON.parse(unescape(m[1])); if (Array.isArray(j.findings)) return j; } catch { /* not the dump */ }
    }
  }
  return null;
}

let flagged = 0, reviewed = 0, planned = 0;
const queue = groups.slice();
const rows = new Map();
await Promise.all(Array.from({ length: 3 }, async () => {
  for (let g; (g = queue.shift()); ) for (const u of g) rows.set(u.url, await debugOf(u.url));
}));
for (const u of groups.flat()) {
  const dbg = rows.get(u.url);
  if (!dbg) { console.log(`${u.label.padEnd(32)} no review (${u.url})`); continue; }
  const problems = dbg.findings.filter(f => /^(bad|warn) /.test(f));
  reviewed++; flagged += problems.length;
  console.log(`${u.label.padEnd(32)} ${problems.length}${dbg.selfInPool >= 0 ? '' : ' (not a pool member)'}  ${u.url}`);
  for (const f of problems) console.log(`    ${f}`);
  // The plan: prep lines (potions, consumables) are fine on a top player; anything else is counted.
  const np = dbg.nextPull;
  if (!np) continue;
  planned += np.actions.filter(a => !a.startsWith('prep |')).length;
  for (const a of np.actions) console.log(`    plan: ${a}`);
  if (np.clean) console.log(`    plan: (clean) ${np.clean}`);
  for (const r of np.defensivePlan ?? []) console.log(`    defensives: ${r}`);
  if (planDebug) console.log(JSON.stringify({ targetsOpen: np.targetsOpen, candidates: np.candidates, rates: np.rates, damage: np.damage }, null, 1).split('\n').map(l => `      ${l}`).join('\n'));
}
console.log(`\n${reviewed} reviewed, ${flagged} bad/warn findings, ${planned} plan actions about how the pull was played`);
