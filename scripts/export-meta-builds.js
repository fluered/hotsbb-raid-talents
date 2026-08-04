#!/usr/bin/env node
// Batch-generates addon/HotsBBTalents/Data.lua by calling /api/meta-build across
// every class/spec x boss/dungeon combo. Targets the live site by default (not
// localhost) so combos real visitors have loaded recently are served from the site's
// own 24h data cache instead of costing a fresh WCL request.
//
// Usage:
//   node scripts/export-meta-builds.js [--base https://hotsbbtalents.io] [--concurrency 6] [--limit N]

const fs = require('fs');
const path = require('path');

function argVal(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : fallback;
}
const BASE = argVal('--base', 'https://hotsbbtalents.io');
const CONCURRENCY = parseInt(argVal('--concurrency', '6'));
const LIMIT = argVal('--limit', null) ? parseInt(argVal('--limit', null)) : null;
// A rate-limited run silently drops whole classes (WCL 429s look identical to "no
// data" further down the pipeline). Without --force-write, an aborted run (safety
// ceiling hit below) refuses to touch Data.lua so a bad partial run can't clobber a
// good prior one.
const FORCE_WRITE = process.argv.includes('--force-write');

// Mirrors lib/wow.ts SPEC_IDS
const SPEC_IDS = {
  'Death Knight':  { 'Blood': 250, 'Frost': 251, 'Unholy': 252 },
  'Demon Hunter':  { 'Havoc': 577, 'Vengeance': 581, 'Devourer': 1480 },
  'Druid':         { 'Balance': 102, 'Feral': 103, 'Guardian': 104, 'Restoration': 105 },
  'Evoker':        { 'Devastation': 1467, 'Preservation': 1468, 'Augmentation': 1473 },
  'Hunter':        { 'Beast Mastery': 253, 'Marksmanship': 254, 'Survival': 255 },
  'Mage':          { 'Arcane': 62, 'Fire': 63, 'Frost': 64 },
  'Monk':          { 'Brewmaster': 268, 'Mistweaver': 270, 'Windwalker': 269 },
  'Paladin':       { 'Holy': 65, 'Protection': 66, 'Retribution': 70 },
  'Priest':        { 'Discipline': 256, 'Holy': 257, 'Shadow': 258 },
  'Rogue':         { 'Assassination': 259, 'Outlaw': 260, 'Subtlety': 261 },
  'Shaman':        { 'Elemental': 262, 'Enhancement': 263, 'Restoration': 264 },
  'Warlock':       { 'Affliction': 265, 'Demonology': 266, 'Destruction': 267 },
  'Warrior':       { 'Arms': 71, 'Fury': 72, 'Protection': 73 },
};

// Midnight Season 1 raid bosses (difficulty 5 = Mythic), pulled from /api/debug-boss-data
const RAID_BOSSES = [
  { id: 3159, name: 'Rotmire' },
  { id: 3176, name: 'Imperator Averzian' },
  { id: 3177, name: 'Vorasius' },
  { id: 3179, name: "Fallen-King Salhadaar" },
  { id: 3178, name: 'Vaelgor & Ezzorak' },
  { id: 3180, name: 'Lightblinded Vanguard' },
  { id: 3181, name: 'Crown of the Cosmos' },
  { id: 3306, name: 'Chimaerus, the Undreamt God' },
  { id: 3182, name: "Belo'ren, Child of Al'ar" },
  { id: 3183, name: 'Midnight Falls' },
];
const RAID_DIFFICULTY = 5;

// Mirrors lib/wow.ts MIDNIGHT_DUNGEONS (difficulty 10 = high M+ bracket)
const DUNGEONS = [
  { id: 12805,  name: 'Windrunner Spire' },
  { id: 12874,  name: 'Maisara Caverns' },
  { id: 12915,  name: 'Nexus-Point Xenas' },
  { id: 112526, name: "Algeth'ar Academy" },
  { id: 12811,  name: "Magisters' Terrace" },
  { id: 10658,  name: 'Pit of Saron' },
  { id: 361753, name: 'Seat of the Triumvirate' },
  { id: 61209,  name: 'Skyreach' },
];
const MPLUS_DIFFICULTY = 10;

const jobs = [];
for (const [className, specs] of Object.entries(SPEC_IDS)) {
  for (const [specName, specID] of Object.entries(specs)) {
    for (const boss of RAID_BOSSES) {
      jobs.push({ className, specName, specID, encounterId: boss.id, encounterName: boss.name, difficulty: RAID_DIFFICULTY });
    }
    for (const dungeon of DUNGEONS) {
      jobs.push({ className, specName, specID, encounterId: dungeon.id, encounterName: dungeon.name, difficulty: MPLUS_DIFFICULTY });
    }
  }
}
const activeJobs = LIMIT ? jobs.slice(0, LIMIT) : jobs;
console.log(`Total combos: ${jobs.length}. Running: ${activeJobs.length} (base=${BASE}, concurrency=${CONCURRENCY})`);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchOnce(job) {
  // region=global explicit rather than relying on the API's own default — the addon
  // should always ship the Global (all-regions, including CN) build regardless of
  // whatever the site's default happens to be.
  const url = `${BASE}/api/meta-build?class=${encodeURIComponent(job.className)}&spec=${encodeURIComponent(job.specName)}&boss=${job.encounterId}&difficulty=${job.difficulty}&region=global`;
  try {
    // /api/meta-build now rejects any caller that isn't this script or a real page load
    // (see route.ts) — this header is how it identifies itself.
    const res = await fetch(url, { headers: { 'x-hbt-internal': 'hotsbb-export-script' } });
    const json = await res.json();
    return json;
  } catch (e) {
    return { status: 'fetch_error', message: String(e) };
  }
}

// Pause-and-resume on rate limiting: unlike a hard circuit breaker, a rate_limited
// response just pauses every worker until WCL's own Retry-After elapses, then the
// affected job (and everyone else) resumes. This run has no wall-clock deadline, so
// trading time for completeness is free. A safety ceiling still aborts the whole run
// if the pauses pile up enough to suggest deep quota exhaustion rather than normal
// throttling (e.g. the multi-day-recovery 429 seen from same-day batch testing).
const MAX_WALL_CLOCK_MS = 3 * 60 * 60 * 1000; // 3h absolute ceiling on the whole run
const MAX_CUMULATIVE_PAUSE_MS = 2 * 60 * 60 * 1000; // 2h of *requested* pause time
const startedAt = Date.now();
let pauseUntil = 0;
let cumulativePauseMs = 0;
let pauseCount = 0;
let aborted = false;
let abortReason = null;

async function respectPause() {
  const now = Date.now();
  if (now < pauseUntil) await sleep(pauseUntil - now);
}

function noteRateLimit(json) {
  const retryAfterSec = parseFloat(json.retryAfter) || 30;
  const waitMs = Math.max(1000, (retryAfterSec + 5) * 1000);
  cumulativePauseMs += waitMs;
  pauseCount++;
  const target = Date.now() + waitMs;
  if (target > pauseUntil) pauseUntil = target;
  if (!aborted && (cumulativePauseMs > MAX_CUMULATIVE_PAUSE_MS || Date.now() - startedAt > MAX_WALL_CLOCK_MS)) {
    aborted = true;
    abortReason = `Exceeded safety ceiling after ${pauseCount} rate-limit pauses (${Math.round(cumulativePauseMs / 60000)} min cumulative wait requested). This looks like deep quota exhaustion, not normal throttling.`;
  }
  process.stdout.write(`\n⏸  WCL rate-limited (pause #${pauseCount}) — waiting ~${Math.round(waitMs / 1000)}s before resuming...\n`);
}

// Transient network failures get a couple of bounded retries. Rate limiting gets
// unlimited retries (each one gated behind respectPause) since the job WILL succeed
// once the pause elapses — it's not actually failing, just waiting its turn.
async function fetchJob(job) {
  let errorAttempts = 0;
  while (true) {
    if (aborted) return { job, json: { status: 'aborted' } };
    await respectPause();
    if (aborted) return { job, json: { status: 'aborted' } };

    const json = await fetchOnce(job);

    if (json.status === 'rate_limited') {
      noteRateLimit(json);
      continue;
    }
    if ((json.status === 'error' || json.status === 'fetch_error') && errorAttempts < 2) {
      errorAttempts++;
      await sleep(1500 * errorAttempts);
      continue;
    }
    return { job, json };
  }
}

async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
      done++;
      if (done % 5 === 0 || done === items.length) {
        process.stdout.write(`\r${done}/${items.length} done`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  process.stdout.write('\n');
  return results;
}

function luaStr(s) {
  if (s == null) return 'nil';
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// Serializes a {nodeID: number} map (frequencyPct or entryIds) into a Lua table
// literal keyed by numeric nodeID, e.g. { [94962] = 100, [94966] = 87, }
function luaNumMap(obj) {
  const keys = Object.keys(obj || {});
  if (keys.length === 0) return '{}';
  return '{ ' + keys.map(k => `[${k}] = ${obj[k]}`).join(', ') + ' }';
}

// Serializes wclEntries — built entirely from WCL telemetry, no Blizzard character
// profile involved — into a Lua array ready for C_ClassTalents.ImportLoadout, skipping
// the string encode/decode round-trip the old importString path needed.
function luaEntries(entries) {
  if (!entries || entries.length === 0) return 'nil';
  return '{ ' + entries.map(e =>
    `{nodeID=${e.nodeID},ranksGranted=${e.ranksGranted},ranksPurchased=${e.ranksPurchased},selectionEntryID=${e.selectionEntryID}}`
  ).join(', ') + ' }';
}

(async () => {
  const results = await mapConcurrent(activeJobs, CONCURRENCY, fetchJob);

  const statusCounts = {};
  const bySpec = new Map(); // specID -> encounterName -> data
  const errors = [];
  for (const { job, json } of results) {
    statusCounts[json.status] = (statusCounts[json.status] || 0) + 1;
    if (json.status === 'error' || json.status === 'fetch_error') {
      errors.push(`${job.className}/${job.specName} vs ${job.encounterName}: ${json.message}`);
    }
    if (json.status !== 'ok') continue;
    if (!bySpec.has(job.specID)) bySpec.set(job.specID, new Map());
    bySpec.get(job.specID).set(job.encounterName, json.data);
  }
  console.log('Status breakdown:', statusCounts);
  if (errors.length) {
    console.log(`First ${Math.min(10, errors.length)} errors:`);
    errors.slice(0, 10).forEach(e => console.log('  ' + e));
  }

  // Full class coverage check, independent of the abort path — a spec with zero
  // encounters (all 'no_data'/'error') is invisible in Data.lua just like one that
  // never ran, so surface it explicitly rather than letting it pass silently.
  const missingSpecs = [];
  for (const [className, specs] of Object.entries(SPEC_IDS)) {
    for (const [specName, specID] of Object.entries(specs)) {
      if (!bySpec.has(specID) || bySpec.get(specID).size === 0) {
        missingSpecs.push(`${className}/${specName} (${specID})`);
      }
    }
  }
  if (missingSpecs.length) {
    console.log(`\nSpecs with NO data at all (${missingSpecs.length}): ${missingSpecs.join(', ')}`);
  }

  if (pauseCount > 0) {
    console.log(`\nPaused for rate limiting ${pauseCount} time(s), ${Math.round(cumulativePauseMs / 60000)} min cumulative wait.`);
  }

  if (aborted) {
    const completed = results.filter(r => r.json.status !== 'aborted').length;
    const skipped = results.length - completed;
    console.log(`\n🛑 Aborted: ${abortReason}`);
    console.log(`   ${completed}/${results.length} jobs completed before the abort, ${skipped} skipped.`);
    if (!FORCE_WRITE) {
      console.log(`   Refusing to overwrite Data.lua with a partial/incomplete run — the existing file is untouched.`);
      console.log(`   Wait a while and re-run, or pass --force-write to write this partial data anyway.`);
      process.exitCode = 1;
      return;
    }
    console.log(`   --force-write passed — writing partial data anyway.`);
  }

  const lines = [];
  lines.push('-- Auto-generated by scripts/export-meta-builds.js. Do not hand-edit — regenerate instead.');
  lines.push(`-- Generated ${new Date().toISOString()}.`);
  lines.push('');
  lines.push('HotsBBTalentsData = {');
  for (const [specID, encounters] of [...bySpec.entries()].sort((a, b) => a[0] - b[0])) {
    lines.push(`  [${specID}] = {`);
    for (const [encounterName, data] of encounters) {
      lines.push(`    [${luaStr(encounterName)}] = {`);
      lines.push(`      sampleSize = ${data.sampleSize},`);
      lines.push(`      fetchedAt = ${data.fetchedAt},`);
      lines.push('      variants = {');
      for (const v of data.variants) {
        lines.push('        {');
        lines.push(`          heroTreeId = ${v.id === null ? 'nil' : v.id},`);
        lines.push(`          heroTreeName = ${luaStr(v.name)},`);
        lines.push(`          sampleSize = ${v.count},`);
        lines.push(`          importString = ${luaStr(v.talentString)},`);
        lines.push(`          frequencyPct = ${luaNumMap(v.frequencyPct)},`);
        lines.push(`          entryIds = ${luaNumMap(v.entryIds)},`);
        lines.push(`          wclEntries = ${luaEntries(v.wclEntries)},`);
        lines.push('        },');
      }
      lines.push('      },');
      lines.push('    },');
    }
    lines.push('  },');
  }
  lines.push('}');
  lines.push('');

  const outPath = path.join(__dirname, '..', 'addon', 'HotsBBTalents', 'Data.lua');
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`Wrote ${outPath} — ${bySpec.size} specs with data.`);
})();
