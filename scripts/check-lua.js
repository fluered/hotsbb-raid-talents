#!/usr/bin/env node
// Real syntax validation for the addon's Lua (no Lua binary exists on dev machines or
// CI runners here) — luaparse with WoW's Lua 5.1 semantics. A Data.lua/Core.lua that
// doesn't parse bricks the addon for every WowUp user on their next update, so this
// runs in CI and belongs in any release pipeline touching these files.
const fs = require('fs');
const path = require('path');
const luaparse = require('luaparse');

const dir = path.join(__dirname, '..', 'addon', 'HotsBBTalents');
let failed = false;
for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.lua'))) {
  const src = fs.readFileSync(path.join(dir, file), 'utf8');
  try {
    luaparse.parse(src, { luaVersion: '5.1' });
    console.log(`OK  ${file}`);
  } catch (e) {
    failed = true;
    console.error(`FAIL ${file}: ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
