# HotsBB Talents (addon)

**Import confirmed working in-game.** Compliance overlay (Phase 3) is
implemented but **not yet tested in-game** — see that section below.

## What this does

`/hbt` opens a panel listing bundled meta talent builds for your **currently
active spec** (detected automatically). Each row has:
- **Import** — decodes the build string client-side, then applies it via
  `C_ClassTalents.ImportLoadout`. Confirmed working.
- **Copy** — shows the raw import string in a selectable box, to paste into
  the built-in Talents panel's own Import dialog by hand. Always works
  regardless of Import's status, since it doesn't depend on any decode logic.
- **Compare** — draws colored borders directly on your real Talents UI
  showing how your current selections differ from that build. Not yet
  tested in-game — see "Compliance overlay" below.

A **Clear Overlay** button in the top-right of the panel removes any active
comparison borders.

## Install (manual, for testing — no packager set up yet)

Copy this whole `HotsBBTalents` folder into your WoW `_retail_/Interface/AddOns/`
directory, then `/reload` or restart the client. Enable it at the character
select AddOns list if it isn't already.

## Import status: confirmed working

First attempt: `ImportLoadout(configID, {}, name, importString)` reported
success but produced a completely **empty** loadout. Root cause: `entries`
(an array of `{nodeID, ranksGranted, ranksPurchased, selectionEntryID}`
records) is what Blizzard's API actually uses to build the loadout —
the raw `importString` argument is not auto-decoded internally as hoped.
Passing `entries = {}` is exactly why nothing got selected.

Second attempt (current `Core.lua`): the loadout string is decoded into real
`entries` client-side before calling `ImportLoadout` — a faithful line-by-line
Lua port of Blizzard's own decode logic (`ClassTalentImportExportMixin` in
`Interface/AddOns/Blizzard_PlayerSpells/ClassTalents/Blizzard_ClassTalentImportExport.lua`),
using `ExportUtil.MakeImportDataStream` (Blizzard's own built-in bitstream
reader) rather than a custom base64 implementation. **Verified working
in-game** on Hunter Beast Mastery — the correct talents were applied.

**Expected side effect, not a bug:** applying a substantially different
build can leave empty slots on your action bars where abilities you no
longer have used to sit. The game doesn't try to guess where changed/new
spells should go. Your spellbook is unaffected — just re-drag what you want
from the spellbook (`P`) back onto your bars. This happens with Blizzard's
own built-in Import too on a big enough build change; it's not specific to
this addon.

## Compliance overlay (Phase 3): implemented, NOT yet tested in-game

Clicking **Compare** on a build row draws colored borders directly on the
real Talents UI nodes, comparing your current selections against that
build's bundled `frequencyPct`/`entryIds`:
- **Amber border** — the meta build takes this node (≥50% pick rate), you don't
- **Blue border** — you have this node, most meta builds skip it
- **Red border** — choice node where you picked the other option

This is the riskiest piece of the addon, by design choice (discussed and
agreed on explicitly rather than defaulted into): it touches Blizzard's own
protected Talents UI, which this project has hit real taint issues with
before on this WoW version (in a related addon project). To minimize that
risk:
- Every overlay element is a child of the addon's own frame (parented to
  `UIParent`), never a child of any Blizzard frame or button — only
  `SetPoint` is used to visually align to a button, which is a read-only
  positional reference, not a parenting relationship that could carry taint.
- Only `C_Traits.GetNodeInfo` / `C_ClassTalents.GetActiveConfigID` are called
  (both read-only). Nothing that spends points or otherwise mutates state.
- Refreshes are driven only by `RegisterEvent("TRAIT_CONFIG_UPDATED")` and
  `HookScript("OnShow", ...)` / `hooksecurefunc(PlayerSpellsFrame, "Show", ...)`
  — Blizzard's own sanctioned safe-extension APIs. Nothing is intercepted or
  replaced.
- The whole draw pass is wrapped in `pcall`; any error prints clearly and
  clears the overlay rather than leaving it in a broken state.

Frame path (`PlayerSpellsFrame.TalentsFrame`, `:EnumerateAllTalentButtons()`,
`button:GetNodeInfo()`) was confirmed directly from Blizzard's own live
source (`Blizzard_PlayerSpellsFrame.xml` / `Blizzard_ClassTalentsFrame.lua`
in the `Gethe/wow-ui-source` mirror), not guessed. Still, this is new code
touching live protected UI and **has not been run in-game yet**. If clicking
Compare does nothing, errors, or (worst case) causes anything to feel
"blocked"/unresponsive elsewhere in the UI afterward, stop and report back
immediately — `/reload` should clear any addon-side state regardless, since
nothing here is saved.

## Other unverified item: `.toc` Interface number

`## Interface: 120000` is a guess at the 12.0.0 build number for Midnight.
If the addon shows as "out of date" in your AddOns list, check the actual
number with `/dump select(4, GetBuildInfo())` in-game.

## Data

`Data.lua` is generated by `scripts/export-meta-builds.js`, which calls
`/api/meta-build` across every class/spec x boss/dungeon combo. Regenerate
it with:

```
node scripts/export-meta-builds.js --base http://localhost:3000 --concurrency 2
```

Keep concurrency low (2-ish) — each combo already fans out to ~75 sub-requests
internally against Blizzard/WCL, so higher concurrency triggers rate limiting
(confirmed: concurrency 8 produced an 96% error rate that all cleared up when
retried individually). Run against a local `next start`, not the live production
URL, to avoid adding load to the deployment real users hit.
