#!/usr/bin/env node
// Batch-generates addon/HotsBBTalents/Data.lua by calling /api/meta-build across
// every class/spec x boss/dungeon combo. Targets the live site by default (not
// localhost) so combos real visitors have loaded recently are served from the site's
// own 24h data cache instead of costing a fresh WCL request.
//
// Usage:
//   node scripts/export-meta-builds.js [--base https://hotsbbtalents.io] [--concurrency 6] [--limit N] [--warm-only]

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
// Warm-only: run the exact same sweep — every combo through /api/meta-build, which
// force-refreshes the site's shared rankings cache and telemetry — but never touch
// Data.lua. This is how the site's caches stay hot for every spec without any user
// interaction (the daily warm-site-cache workflow), decoupled from the weekly release.
const WARM_ONLY = process.argv.includes('--warm-only');

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

// Difficulty enum values are WCL-wide constants, not season-specific. WHICH raid
// difficulty to crawl comes from /api/season-content (resolved live server-side:
// Heroic during launch weeks, Mythic once it has parses) — RAID_DIFFICULTY is only
// the fallback for an older server that doesn't send the field.
const RAID_DIFFICULTY = 4;
const MPLUS_DIFFICULTY = 10;

// Raid bosses and dungeons used to be hardcoded here, snapshotted by hand each season
// from /api/debug-boss-data — which meant every new season silently broke this script
// until someone noticed and manually re-typed a new encounter ID list. Fetched live
// from /api/season-content instead (same getDungeonRoster/getRaidStructure calls the
// website's own pages use), so a new season only needs MPLUS_ZONE_ID/MIDNIGHT_RAIDS
// updated in lib/wow.ts — this script picks up the new content pool automatically.
async function fetchSeasonContent() {
  const res = await fetch(`${BASE}/api/season-content`, { headers: { 'x-hbt-internal': 'hotsbb-export-script' } });
  const json = await res.json();
  if (json.status !== 'ok') throw new Error(`Failed to fetch season content: ${json.message ?? JSON.stringify(json)}`);
  return json;
}

// Everything about "what content is in this season" that the addon needs at runtime,
// captured once per export so Data.lua is self-describing. The addon used to carry its
// own hardcoded boss/dungeon roster in Core.lua — which silently fell out of sync at the
// Season 2 rollover (Core.lua still listed Season 1 names, so every card read "No data
// yet" even though Data.lua was full). Shipping the roster with the data makes that
// class of bug impossible.
let seasonInfo = null;

async function buildJobs() {
  const season = await fetchSeasonContent();
  const { dungeons, raidBosses, defaultRaidDifficulty, drift } = season;
  if (drift) console.warn(`\n⚠  SEASON DRIFT: ${drift}\n`);
  const raidDifficulty = defaultRaidDifficulty ?? RAID_DIFFICULTY;
  console.log(`Raid difficulty (from season-content): ${raidDifficulty === 5 ? 'Mythic' : 'Heroic'}`);
  seasonInfo = {
    seasonLabel: season.seasonLabel ?? null,
    expansionName: season.expansionName ?? null,
    raidDifficulty,
    raidZones: season.raidZones ?? [...new Set(raidBosses.map(b => b.zone).filter(Boolean))],
    // WCL reports journalID 0 when it has none — emit nil so Core.lua treats it as missing.
    raidBosses: raidBosses.map(b => ({ name: b.name, wclId: b.id, journalId: b.journalId || null, zone: b.zone ?? null })),
    dungeons: dungeons.map(d => ({ name: d.name, wclId: d.id, journalInstanceId: d.blizzardInstanceId || null })),
  };
  const jobs = [];
  for (const [className, specs] of Object.entries(SPEC_IDS)) {
    for (const [specName, specID] of Object.entries(specs)) {
      for (const boss of raidBosses) {
        jobs.push({ className, specName, specID, encounterId: boss.id, encounterName: boss.name, difficulty: raidDifficulty, isRaid: true });
      }
      for (const dungeon of dungeons) {
        jobs.push({ className, specName, specID, encounterId: dungeon.id, encounterName: dungeon.name, difficulty: MPLUS_DIFFICULTY });
      }
    }
  }
  console.log(`Season content: ${raidBosses.length} raid bosses, ${dungeons.length} dungeons.`);
  return jobs;
}

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
// Raised from 3h/2h, then again from 6h/4h after back-to-back runs still died at this
// ceiling despite fixing a real double-counting bug in cumulativePauseMs (concurrent
// workers hitting the same rate-limit window each counted its full duration instead of
// the actual overlapping wall-clock delay once) — WCL's throttling that night was
// simply severe enough that even the deduplicated total exceeded 4h. Restarting from
// scratch on every abort has real overhead (re-walking hundreds of already-cached
// combos before reaching new ground), so a single run waiting longer beats repeated
// full restarts whenever the option exists — unattended runs (e.g. overnight) should
// favor this.
const MAX_WALL_CLOCK_MS = 12 * 60 * 60 * 1000; // 12h absolute ceiling on the whole run
const MAX_CUMULATIVE_PAUSE_MS = 9 * 60 * 60 * 1000; // 9h of *requested* pause time
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
  pauseCount++;
  const now = Date.now();
  const target = now + waitMs;
  // cumulativePauseMs is meant to approximate real wall-clock time lost to rate
  // limiting. With concurrency > 1, several workers can hit the same rate-limit
  // window within milliseconds of each other and each call this — summing every
  // report's full waitMs double/triple/N-counts one overlapping delay (5 workers
  // reporting the same ~54min pause inflated that into ~4.5h "cumulative", enough
  // to trip the abort ceiling despite the real delay being nowhere close). Only the
  // portion of this pause that extends *beyond* whatever's already pending counts.
  const effectiveStart = Math.max(now, pauseUntil);
  cumulativePauseMs += Math.max(0, target - effectiveStart);
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

// Per-boss difficulty fallback. The season's default raid difficulty is Mythic once it has
// parses, but the last bosses of a tier stay thin on Mythic for weeks (The Coiled Altar,
// Ula'tek, Kith'ix in Season 2). A spec/boss combo that returns no_data or
// insufficient_data on Mythic is retried on Heroic and tagged with the difficulty it
// actually used, so the addon can label the card "Heroic". Once Mythic parses exist the
// next crawl replaces it automatically — no human flips anything.
const HEROIC_DIFFICULTY = 4;
let fallbackCount = 0;
async function fetchJobWithFallback(job) {
  const result = await fetchJob(job);
  const thin = result.json.status === 'no_data' || result.json.status === 'insufficient_data';
  if (thin && job.isRaid && job.difficulty !== HEROIC_DIFFICULTY) {
    const heroic = await fetchJob({ ...job, difficulty: HEROIC_DIFFICULTY });
    if (heroic.json.status === 'ok') {
      fallbackCount++;
      heroic.json.data.difficulty = HEROIC_DIFFICULTY;
      return heroic;
    }
    return result; // keep the original (more specific) status for the stats breakdown
  }
  if (result.json.status === 'ok') result.json.data.difficulty = job.difficulty;
  return result;
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
  // Control characters would end up raw inside a Lua short-string literal, which is a
  // syntax error that bricks the addon for every user on load — escape them. Names come
  // from WCL/Blizzard, i.e. external data we don't control.
  return '"' + String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, c => '\\' + c.charCodeAt(0)) + '"';
}

// Compact string encodings, decoded lazily in Core.lua (ParseFreq / ParseEntries).
// The previous nested-table form created ~100k tiny Lua tables at file load for
// 1,500 variants — several MB of live memory and a noticeable login hitch — when a
// given session only ever looks at one spec's ~17 encounters. A string costs one
// allocation and is parsed only when its card is actually rendered or imported.

// {nodeID: pct} → "nodeID:pct,nodeID:pct,…" (sorted by nodeID for stable diffs)
function luaFreq(obj) {
  const keys = Object.keys(obj || {}).map(Number).sort((a, b) => a - b);
  if (keys.length === 0) return 'nil';
  return '"' + keys.map(k => `${k}:${obj[k]}`).join(',') + '"';
}

// wclEntries — built entirely from WCL telemetry, no Blizzard character profile
// involved — as "nodeID:selectionEntryID:ranksPurchased[:ranksGranted]" rows, order
// preserved (Core.lua re-sorts into tree order anyway). ranksGranted is omitted when 0.
function luaEntries(entries) {
  if (!entries || entries.length === 0) return 'nil';
  return '"' + entries.map(e =>
    `${e.nodeID}:${e.selectionEntryID}:${e.ranksPurchased}` + ((e.ranksGranted || 0) > 0 ? `:${e.ranksGranted}` : '')
  ).join(',') + '"';
}

(async () => {
  const jobs = await buildJobs();
  const activeJobs = LIMIT ? jobs.slice(0, LIMIT) : jobs;
  console.log(`Total combos: ${jobs.length}. Running: ${activeJobs.length} (base=${BASE}, concurrency=${CONCURRENCY})`);

  const results = await mapConcurrent(activeJobs, CONCURRENCY, fetchJobWithFallback);
  if (fallbackCount > 0) console.log(`Heroic fallback used for ${fallbackCount} raid combo(s) that were thin on Mythic.`);

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

  if (WARM_ONLY) {
    // The sweep itself was the product: every combo's SWR entry is now fresh and its
    // telemetry warm. Data.lua and all its partial-run guards are the release path's
    // concern, not ours. Exit non-zero on an abort purely so the workflow run shows
    // red — a failed warm costs nothing but is worth noticing if it becomes a pattern.
    console.log(`\n✅ Warm-only run complete — Data.lua untouched.`);
    if (aborted) {
      console.log(`   (Run aborted early: ${abortReason})`);
      process.exitCode = 1;
    }
    return;
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

  // The abort guard above only covers rate-limit exhaustion. A deploy/outage mid-crawl
  // (5xx / HTML responses → 'fetch_error'), an auth change on /api/meta-build (every
  // combo some non-ok status), or anything else that fails whole swaths of combos would
  // otherwise still be written, committed, and *released* — silently gutting data every
  // WowUp user then downloads. Same invariant as the abort path: partial data must
  // never overwrite good data.
  const knownStatuses = new Set(['ok', 'no_data', 'error', 'fetch_error', 'aborted']);
  const unknownCount = Object.entries(statusCounts)
    .filter(([s]) => !knownStatuses.has(s))
    .reduce((sum, [, n]) => sum + n, 0);
  const failureCount = (statusCounts.error || 0) + (statusCounts.fetch_error || 0) + unknownCount;
  const failureBudget = Math.max(5, Math.round(activeJobs.length * 0.01)); // ~1%, min 5
  const partialReasons = [];
  if (failureCount > failureBudget) partialReasons.push(`${failureCount} combos failed (budget: ${failureBudget})`);
  if (missingSpecs.length > 0) partialReasons.push(`${missingSpecs.length} spec(s) have no data at all`);
  if (bySpec.size === 0) partialReasons.push('zero combos returned data');
  if (partialReasons.length > 0 && !FORCE_WRITE) {
    console.log(`\n🛑 Refusing to write Data.lua — this run looks partial: ${partialReasons.join('; ')}.`);
    console.log(`   The existing file is untouched. Re-run once the cause is fixed, or pass --force-write to override.`);
    process.exitCode = 1;
    return;
  }
  if (partialReasons.length > 0) {
    console.log(`\n⚠  Writing despite partial-run signals (${partialReasons.join('; ')}) — --force-write passed.`);
  }

  const lines = [];
  lines.push('-- Auto-generated by scripts/export-meta-builds.js. Do not hand-edit — regenerate instead.');
  lines.push(`-- Generated ${new Date().toISOString()}.`);
  lines.push('');
  // Schema version lets Core.lua refuse a Data.lua it doesn't understand (and tell the
  // user to update) instead of erroring on load. Bump when a field's meaning changes.
  const nilable = v => (v === null || v === undefined) ? 'nil' : v;
  lines.push('HotsBBTalentsMeta = {');
  lines.push('  schemaVersion = 2,');
  lines.push(`  generatedAt = ${Math.floor(Date.now() / 1000)},`);
  lines.push(`  seasonLabel = ${luaStr(seasonInfo?.seasonLabel)},`);
  lines.push(`  expansionName = ${luaStr(seasonInfo?.expansionName)},`);
  lines.push(`  raidDifficulty = ${nilable(seasonInfo?.raidDifficulty)},`);
  lines.push(`  raidDifficultyName = ${luaStr(seasonInfo ? (seasonInfo.raidDifficulty === 5 ? 'Mythic' : 'Heroic') : null)},`);
  lines.push(`  raidZones = { ${(seasonInfo?.raidZones ?? []).map(luaStr).join(', ')} },`);
  lines.push('}');
  lines.push('');
  lines.push('HotsBBTalentsRoster = {');
  lines.push('  raid = {');
  for (const b of seasonInfo?.raidBosses ?? []) {
    lines.push(`    { name = ${luaStr(b.name)}, wclId = ${nilable(b.wclId)}, journalId = ${nilable(b.journalId)}, zone = ${luaStr(b.zone)} },`);
  }
  lines.push('  },');
  lines.push('  dungeons = {');
  for (const d of seasonInfo?.dungeons ?? []) {
    lines.push(`    { name = ${luaStr(d.name)}, wclId = ${nilable(d.wclId)}, journalInstanceId = ${nilable(d.journalInstanceId)} },`);
  }
  lines.push('  },');
  lines.push('}');
  lines.push('');
  lines.push('HotsBBTalentsData = {');
  for (const [specID, encounters] of [...bySpec.entries()].sort((a, b) => a[0] - b[0])) {
    lines.push(`  [${specID}] = {`);
    for (const [encounterName, data] of encounters) {
      lines.push(`    [${luaStr(encounterName)}] = {`);
      lines.push(`      sampleSize = ${data.sampleSize},`);
      lines.push(`      fetchedAt = ${data.fetchedAt},`);
      // Raid only: the WCL difficulty these parses came from (5 Mythic, 4 Heroic). Core.lua
      // labels the card when it differs from HotsBBTalentsMeta.raidDifficulty.
      if (data.difficulty != null && data.difficulty !== MPLUS_DIFFICULTY) lines.push(`      difficulty = ${data.difficulty},`);
      lines.push('      variants = {');
      for (const v of data.variants) {
        lines.push('        {');
        lines.push(`          heroTreeId = ${v.id === null ? 'nil' : v.id},`);
        lines.push(`          heroTreeName = ${luaStr(v.name)},`);
        lines.push(`          sampleSize = ${v.count},`);
        lines.push(`          importString = ${luaStr(v.talentString)},`);
        // freq feeds the in-game "your build vs meta" diff (how contested each pick
        // is). entryIds was dropped: fully redundant with the entries and nothing in
        // Core.lua read it — ~15% of a 13MB file.
        lines.push(`          freq = ${luaFreq(v.frequencyPct)},`);
        lines.push(`          entries = ${luaEntries(v.wclEntries)},`);
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
