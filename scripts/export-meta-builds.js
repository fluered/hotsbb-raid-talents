#!/usr/bin/env node
// Batch-generates addon/HotsBBTalents/Data.lua by calling /api/meta-build across
// every class/spec x boss/dungeon combo. Run against a local `next start` (production
// build) so it doesn't add load to the live Vercel deployment.
//
// Usage:
//   node scripts/export-meta-builds.js [--base http://localhost:3000] [--concurrency 6] [--limit N]

const fs = require('fs');
const path = require('path');

function argVal(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : fallback;
}
const BASE = argVal('--base', 'http://localhost:3000');
const CONCURRENCY = parseInt(argVal('--concurrency', '6'));
const LIMIT = argVal('--limit', null) ? parseInt(argVal('--limit', null)) : null;

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
  const url = `${BASE}/api/meta-build?class=${encodeURIComponent(job.className)}&spec=${encodeURIComponent(job.specName)}&boss=${job.encounterId}&difficulty=${job.difficulty}`;
  try {
    const res = await fetch(url);
    const json = await res.json();
    return json;
  } catch (e) {
    return { status: 'fetch_error', message: String(e) };
  }
}

// Transient rate-limit/network failures are common when hammering Blizzard/WCL at
// concurrency — retry a couple of times with backoff before giving up on a combo.
async function fetchJob(job) {
  let json = await fetchOnce(job);
  for (let attempt = 0; (json.status === 'error' || json.status === 'fetch_error') && attempt < 2; attempt++) {
    await sleep(1500 * (attempt + 1));
    json = await fetchOnce(job);
  }
  return { job, json };
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
