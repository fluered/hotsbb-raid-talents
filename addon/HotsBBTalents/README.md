# HotsBB Talents (addon) — Phase 2 proof of concept

Import panel only. No compliance overlay yet (that's Phase 3, once this shell is
confirmed working in-game).

## What this does

`/hbt` opens a panel listing bundled meta talent builds for your **currently
active spec** (detected automatically). Each row has:
- **Import** — attempts to load the build directly via the in-game talent API
- **Copy** — shows the raw import string in a selectable box, to paste into
  the built-in Talents panel's own Import dialog by hand

Copy is the guaranteed-safe fallback. Import is best-effort — see below.

## Install (manual, for testing — no packager set up yet)

Copy this whole `HotsBBTalents` folder into your WoW `_retail_/Interface/AddOns/`
directory, then `/reload` or restart the client. Enable it at the character
select AddOns list if it isn't already.

## Two things I could not verify without a live client

I don't have a way to launch WoW myself, so these are best-effort and need
your testing to confirm:

1. **`## Interface: 120000`** in the .toc — this is a guess at the 12.0.0
   build number for Midnight. If the addon shows as "out of date" in your
   AddOns list, check the actual number with `/dump select(4, GetBuildInfo())`
   in-game and I'll update the .toc to match.

2. **The Import button's API call** (`Core.lua`, `ImportBuild()`) — uses
   `C_ClassTalents.ImportLoadout(configID, {}, name, importString)`. The
   4th argument (raw string) was documented as added in patch 11.2.5; I
   couldn't confirm the exact behavior on 12.x. If clicking Import does
   nothing or prints a red error, **copy the exact error text from chat**
   and send it back — that tells me exactly which part of the call to fix.
   Copy always works regardless, since it doesn't depend on this guess.

## Data

`Data.lua` currently has real sample data for exactly two spec/boss
combos (Hunter Beast Mastery and Paladin Holy, vs. Rotmire) pulled live
from `/api/meta-build` — enough to test the panel end-to-end. It is
**not** the full dataset. Once the shell above is confirmed working,
next step is a batch script that calls `/api/meta-build` across every
class/spec/boss/difficulty combo and regenerates this file completely.
