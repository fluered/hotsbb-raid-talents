# Log Review gap inventory (2026-10-25)

Six research passes over the sources the review already uses (lorrgs, Wipefest, Warcraft Logs, DBM, the Blizzard journal, Wowhead) plus WoWAnalyzer, BigWigs and a survey of rival tools. Every item below was read from a file, a schema, or a live API call on 2026-10-25; items the passes could not confirm are marked UNVERIFIED. Raw material (downloaded files, probe scripts, API payloads) sits in the session scratchpad folders `lorrgs-deep`, `wowanalyzer-deep`, `wcl-deep`, `wipefest-deep`, `boss-sources-deep`, `competitors-deep`.

> **Status 2026-11-02.** Built and shipped from this list: every item in section 1 except racials; named boss casts, real phase names, where a wipe ended, and boss health (A); externals, Power Infusion and Bloodlust (B/E); uses-vs-cooldown and pre-pull presses (B/C); Wipefest percentiles (J, as an experiment); the generic Wipefest insight types death, stackThreshold, phaseDuration, hitFriendly and aggregate; BigWigs aura notes and renames and DBM alt names, id aliases and aura-sound comments (E/L). See lib/lorrgsBosses.ts, lib/bigwigs.ts, lib/wipefestStats.ts. lorrgs moved its data to lorgs/data/retail/ on 2026-11-01; the reader follows it.

~~Nothing here has been built. This is the menu.~~

## 1. Things in our own code that are wrong or lossy

These are not new features. They are places where the review is currently less accurate than it could be, found while auditing the sources.

1. **Wipefest "no config" bosses are never cached.** The API answers HTTP 400 (not 404) for the 90 encounters it has no config for. `getWipefestFightConfig` only treats 404 as "none", so every view of an older-raid boss re-hits Wipefest and logs an error. Current-raid bosses are unaffected.
2. **Wipefest `phases` are event-config ids, not phase numbers.** We parse `phases` with `/P?(\d+)/`. In the configs it is a list of two-character event-config ids (P1, I1, PI, DE, ZX…), 1,395 of 1,413 of which point at phase definitions. The current raid's P/I ids happen to line up with WCL phase ids, so it works by coincidence today and will misfire on bosses whose phases are cast-defined (Lost Explorers P4 is "Binding Anguish" cast).
3. **`excludeCastTarget` ignored.** Sszorak's Ravage and the Twin Fangs' Corrosive Spit count the cast's own target as a hit; Wipefest excludes it. We over-count those cards.
4. **hitWithoutDebuff grace semantics.** Wipefest.Core excuses a hit only if the same target got the debuff within `gracePeriod` before it. For the 34 rules with no remove-debuff definition we open a window to fight end and excuse every later hit.
5. **debuffDuration threshold.** Core averages all spans and reports the over-threshold count separately; we drop sub-threshold spans before averaging, so our average reads higher.
6. **Event-config merge options ignored:** `rangePerActor`, `stack`, `firstPerInstance*`, `index`/`first`/`lastInRange`, `unwrapChildEvents`. Each inflates or deflates a count on specific bosses (Kith'ix H3/W3 use firstPerInstancePerActor).
7. **lorrgs `show` flag misread as importance.** It is only the default toggle. Requiring it drops real majors: Divine Toll, Apotheosis, Rallying Cry, Darkness, Anti-Magic Zone, Odyn's Fury, and the entire TANK tag set (Fiery Brand, Demoralizing Shout, Metamorphosis, Last Resort), which we never use at all.
8. **Externals are invisible.** Our buffs table is `sourceID = targetID = player`, so Pain Suppression, Guardian Spirit, Ironbark, Life Cocoon, BoP, Sacrifice, Power Infusion, Innervate and Bloodlust (tracked via the Sated debuff, ids 57723/57724/80354/264689/390435) are never seen. Death rows cannot say "no external was on you".
9. **Boss ability ids.** DBM comments show the log id differs from the tooltip id ("Script uses 1292036 but it has no tooltip, so we use 1284103") for Possession Barrage, Hungering Pyre and one Ula'tek ability. Our id lookup misses and falls back to name matching.
10. **Encounter matching by name.** BigWigs and DBM carry journal id ↔ WCL encounter id ↔ NPC ids (Nek'zali: journal 2888, WCL 3470, NPC 259927). We normalise names instead.
11. **Racials.** lorrgs tracks Blood Fury, Berserking, Fireblood as cooldown rows; our defensives list says racials are not rows.

## 2. The gap inventory, by theme

### A. Boss timeline, phases and cadence

- **Named boss casts on the timeline.** lorrgs `lorgs/data/expansions/midnight/raids/*/<boss>.py` curates 4–12 casts per boss with spell id, duration and colour (`add_cast`, `add_buff`, `add_debuff`, `extra_filter`, `event_type`). One WCL enemy-cast query per pull. Lets every press finding anchor to a cast: "your Barrier came 6 s before Entropic Unraveling". Coverage is thin on some bosses (placeholders, commented-out heroic entries).
- **Real phase names.** WCL `Report.phases { phases { id name isIntermission } }` returns "Stage One: Fury of the Serpent Mother" etc. at no extra point cost. Our labels are synthesised.
- **Where the wipe happened.** `ReportFight.lastPhase`, `lastPhaseAsAbsoluteIndex`, `lastPhaseIsIntermission` and `bossPercentage` (differs from `fightPercentage` on multi-stage fights: 12.4 % vs 17.4 % on one sampled wipe). Verdict could say "wiped in Stage Three at 17 % boss health".
- **lorrgs' per-boss phase corrections.** Coiled Altar transitions shifted by 8 s / 4 s, Entombed Sentinels keep only transition 1, Lost Explorers "WCL transition IDs unreliable, enumerate by timestamp", Nek'zali phases derived from boss casts. Worth copying.
- **Ability cadence per stage.** BigWigs `gapTimer` tables give explicit recurrences: Essence Rend every 31 s in stage 1, 80 s in stage 2; Possession Barrage 35 s / 52 s; Invoke 32 s in stage 2; opener bars (Soulcoil Ignition at 3 s, Mythic Grasping Depths at 42.5 s); intermission gap 16.5 s. DBM `timersLive` tables give the same as bar durations. Lets the review say "a four-minute stage 2 gives three Rends; you were hit by two".
- **Important: in 12.x both addons read Blizzard's in-game encounter timeline (`ENCOUNTER_TIMELINE_EVENT_ADDED`) and only label it.** The addon tables are the only offline copy of the real cadence; WCL does not expose it.
- **Stage triggers as events.** DBM/BigWigs encode what starts a stage: Nek'zali stage 2 when the 20.5 s Ritual of Awakening channel ends; Ula'tek stage 2 on `UNIT_TARGETABLE_CHANGED`; Coiled Altar stage 3 from a yell pair. Journal gives the health threshold ("Upon reaching 50% health, Nek'zali retreats"). Lets us say "Stage 2 began at 2:31 when the channel ended; the journal says 50 %".
- **Berserk.** DBM `NewBerserkTimer(600)` on Sszorak and Entombed Sentinels. "10-minute berserk; your 7:50 wipe left 2:10".
- **Range mechanics.** DBM info frame "bossdistance 41 minRange" on Entombed Sentinels; option text mentions 48 yd. Sentence only, no log data.
- **Add waves.** `enemyNPCs[].instanceCount/groupCount` (Blightscale Rawling: 64 instances in 6 groups) gives "six add waves spawned".
- **Mythic-only flags.** DBM `--Mythic Only` comments and `MYTHIC_ICON`; BigWigs option `[1293212] = "mythic"`. The journal API does not expose difficulty, so the addons are the only source.

### B. Cooldown judgement

- **Cast efficiency as a number.** WoWAnalyzer: efficiency = time on cooldown ÷ available time; `maxCasts = floor(duration ÷ (cooldown + cast time + GCD wait) + charges − 1) + 1`; default recommended 0.80, "average" at −0.05, "major" at −0.15. Text: "Avatar: 2 of 3 possible casts, 67 % efficiency". We say late/never, not how many uses were possible.
- **Pre-pull detection.** WoWAnalyzer fabricates a `prepull` cast when a buff is present at pull (combatantinfo auras) so "first press late" is not wrong. We judge pre-cast from buffs at pull for potions only.
- **Phase-by-phase press comparison.** Viserio Cooldowns' "Compare vs Top" shades top players' cast windows behind yours and shows the phase where you fall furthest behind. We compare whole-fight medians.
- **Bloodlust alignment.** Azeroth Logs and ExplainMyLogs flag DPS cooldowns early/late/missed relative to Heroism. Needs the Sated/Exhaustion debuff (item 8 above). lorrgs' pool shows Bloodlust in 46 of 50 top Disc logs at a median 0.8 s after pull.
- **Quality inside a burst window.** WoWAnalyzer Combustion: active time inside the window ≥ 90/80/70 %; hardcast filler inside = Fail; cast-to-buff delay ≤ 700 ms. Generalises as "active % during each major cooldown vs top players". Throughput per window (`CooldownThroughputTracker`): "your three Combustions did 38 % of your damage".
- **Clipped channels.** Channel ticks vs expected (Tranquility 5 of 7).
- **Charge capping.** Time sat at max charges (Fire Blast).
- **Opener comparison.** Archon Rotations "Openers" and wow.gg show the first N casts of several top logs on one timeline. We show press times of majors, not opener order. A pool-based cast-order comparison stays inside our no-rulebook rule.
- **Tank majors.** lorrgs TANK-tagged spells are a ready list we never use.
- **Dynamic cooldowns.** lorrgs `DYNAMIC_CD` tag (Army of the Dead, Dark Transformation, Frozen Orb) marks buttons whose cooldown is reduced in play; our ≥60 s rule drops Dark Transformation and Touch of the Magi.
- **lorrgs' precomputed top-50 pools.** `GET api2.lorrgs.io/api/spec_ranking/{spec}/{boss}?difficulty=&metric=` returns 50 fights with every registered spell's casts (including hidden defensives, externals, potions, trinkets) and phases, as a 17 KB gzip. Could cross-check or replace our top-30 medians. No API terms published, single maintainer; ask before depending on it. Known weakness: duplicate characters not removed, pool is best-ever parses since 2026-08-26 rather than recent.

### C. Rotation, uptime and casting

- **GCD-based active time, not cast gaps.** WoWAnalyzer: active = union of [cast, cast + GCD] windows; GCD = 1500 ÷ (1 + haste), floor 750 ms; downtime thresholds DPS > 5/10/15 %, healers > 20/35 %; suppressed when GCD prediction errs more than twice a minute. Our active % comes from WCL's figure and our ≥6 s gaps.
- **Small-gap rate.** Gaps between 100 ms and 2250 ms, flagged above 6/8/10 per minute: "nine half-second pauses per minute".
- **Cancelled casts.** A `begincast` followed by a different `cast` or another `begincast` after 100 ms; thresholds > 2/5/15 %. We fetch only `cast` events.
- **Melee uptime.** Expected next swing from the haste-normalised mean of the last ten intervals; ≥ 98 % Perfect, ≥ 90 % Good. Uses ability id 1.
- **Raid-wide "nothing attackable" windows.** Any ≥ 3 s gap in all melee players' swings excuses everyone's downtime there. One report-wide query.
- **Fixate overlay on downtime.** WoWAnalyzer overlays per-boss debuffs (fixates, vines) on gaps. We already have Wipefest debuff definitions and the player's debuff events; this is a join.
- **Healer non-healing time.** Non-healing GCDs > 30/40/45 %; healing uptime Good if ≥ 0.7 × active.
- **Pandemic clipping.** Refresh with more than 30 % of duration left wastes the remainder; "refreshed Rend early nine times, throwing away 41 s". Needs refreshdebuff events and base durations.
- **DoT uptime on enemies** (< 70/65/60 %). Needs hostile-side debuff table.
- **Proc waste.** Proc buff removed with no consuming cast = expired; refreshbuff of a one-stack proc = overwritten. "4 of your 31 Hot Streaks expired unused." Generalises to any proc buff.
- **AoE hit efficiency** (hits ÷ possible hits < 95/90/80 %), **execute-range tracking** (target HP ≤ 20 % from damage events' `hitPoints/maxHitPoints`).
- **Buff/debuff uptime vs top.** ExplainMyLogs, WoWAnalyzer uptime bars: maintenance buffs, trinket procs. Buffs-table uptime % vs pool median is cheap.
- **Empower rank.** `empowerstart/empowerend{empowermentLevel}` events exist in the log: "Fire Breath cast at rank 1 instead of 3".
- **APL violations** are a per-spec rulebook, so out of bounds. The phrasing and the claim filter are worth borrowing: show a problem only with more than min(10, events ÷ 20) violations and > 40 % of that rule's events; each mistake once, most common first.

### D. Resources

- **Builder/spender breakdown.** Per-ability generated/wasted and spent, from `resourcechange.waste` and cast `classResources`; rage wasted > 25/30/35 %; energy/focus time at cap and missed regen per minute. We have total waste only.
- **Healer mana pacing.** Ending mana > 10/20/30 % flagged; mana curve vs boss HP ("the percent of mana left should match the percent of fight left, just a guideline"); mana potion warranted if mana ever fell below 11,084 after a cast. Needs `classResources` on casts (free with `includeResources: true`).
- **Healing efficiency per spell.** HPM, healing per cast time, % overheal, % of mana per spell.
- **Innervate waste.** Fail if mana capped during the 8 s buff or 5 s after.

### E. Survival and deaths

- **Time dead %.** Any time dead is "major" in WoWAnalyzer; we report deaths, not time lost.
- **HP after each hit and externals in the recap.** Damage events carry `hitPoints/maxHitPoints` with `includeResources`; the Deaths table already carries `events[]`, `deathWindow`, `overkill`, `healing.total` and would replace our two extra per-death queries.
- **How much a defensive saved.** `mitigated = (amount + absorbed + overkill) × 1/(1 − DR) − actual`; Perfect if ≥ 100 % of max HP. Tank damage events carry `mitigated`, `unmitigatedAmount`, `blocked` directly (one sampled hit: 2.14 M unmitigated → 126 k taken, 543 k blocked). DR per defensive needs a documented source (Wowhead tooltip).
- **Spike coverage.** Physical vs magic damage per event overlaid with defensive windows; "covering spikes matters more than total casts".
- **Soft mitigation checks.** Per-hit pass/fail: a listed buff up, a listed debuff on the source, or immune hitType.
- **Healthstone / health potion.** Healthstone 60 s cooldown, one use (three with Pact of Gluttony), only if a Warlock is present; a death with ≥ 60 s left adds a possible use. Wipefest also tracks "cheat death" procs. We count Healthstone presses but not possibility.
- **Death saveability.** wow.gg and WowCoach mark "saves from allies" and healing received in the window; Wipefest death details read "Died over 5.9 s. Took 1,525 k, received 398 k healing".
- **Deaths before the Nth death.** Wipefest recomputes every insight per interval (EntireFight, up to death 1–5, WipeCalled) to power its "ignore everything after the Nth death" control. Our evaluator already takes an interval; WCL `wipeCutoff` and `death: N` arguments do the same server-side (verified: Deaths table 29 → 1 entry with `wipeCutoff: 1`).
- **Died to mechanic X N times.** Wipefest `death` insight type (19 uses across raids); needs only `killingAbilityGameID`, which we already fetch.
- **Consequence debuffs.** DBM `AddAuraSoundOption` comments and BigWigs `SetAuraData` notes bind follow-up debuffs to the failure that causes them: "Calcified Corpse: failed to clear Serpent's Bite", "Dread Roar: missed interrupt", "Toxic Burn warns at 2+ stacks", "Hobbled: tank debuff". BigWigs' version is machine-readable with locale templates. Lets us say "4 players took Calcified Corpse, the debuff for failing to clear Serpent's Bite".
- **Distance moved.** x/y on cast/damage/heal events; yards per minute, time moving. WoWAnalyzer caveats accuracy.
- **Survivability table.** WCL `table(dataType: Survivability)` gives per-player death rate across all pulls and which abilities killed people over the night.

### F. Healing-specific

- Overheal % per healer vs pool (WCL Healing table carries `overheal`; sampled healers 38–59 %).
- Overheal in the first 3 s of a cooldown; targets hit vs expected; a heal on a target below 30 % HP is good regardless of efficiency (triage exemption).
- HoT count before each cooldown ("Wild Growth out before every Tranquility?").
- Healing-cooldown efficiency per cast (overheal %, players hit) and "never cast" cooldowns (Azeroth Logs).
- Healing coverage gaps before each death (Azeroth Logs, WowCoach).
- Healing to tanks vs non-tanks split (Archon Throughput).
- Absorb attribution: `absorbed` events name which shield ate which boss hit (434 in one sampled fight).

### G. Tanks

- Active-mitigation uptime and the spikes between windows (WoWAnalyzer, WoWSoD guide 80 % threshold); Wipefest tracks Major/Minor Tank CDs and Taunts as events.
- Taunt-swap vs defensive triggers from DBM warning types (`NewSpecialWarningTaunt`, `NewSpecialWarningDefensive`); Wipefest `0T` taunt events.
- Brewmaster stagger/purify accounting (spec-specific).

### H. Preparation and gear (all from combatantInfo, which we already fetch)

- **Enchant quality**, not just presence: rank 1 vs rank 3 id lists per slot; "Your boots have a cheap enchant".
- **Gems**: missing sockets per slot; time-gated sockets (helm/belt/bracers) flagged separately. We count gems but not empty sockets (needs bonusID decoding, UNVERIFIED).
- **Weapon oils/stones** via `temporaryEnchant`.
- **Tier set count** via gear `setID` (sampled player wore four pieces of set 2058).
- **Secondary stats** (crit/haste/mastery/vers ratings) vs pool median; already in the playerDetails stats block we fetch.
- **Auras at pull** (`combatantInfo.auras`): flask, food, Vantus Rune, raid buffs (Arcane Intellect, Fortitude, Battle Shout, Mark of the Wild, Skyfury, Bronze, Devotion Aura). "The raid pulled without Arcane Intellect."
- **Potion count vs possible**: `1 + floor((duration − 25 s) ÷ 300 s)`; "used 1 potion, could have used 2".
- **Flask/food tiers, rune uptime, Vantus rune.**
- **Potions by id** from lorrgs (Light's Potential 1236616, Recklessness 1236994, Liquid Luster 1295132, Silvermoon Health 1234768, Lightfused Mana 1236648, Healthstone 6262). Our Wowhead classification already handles these; the id list is a cheaper whitelist.
- **Trinket meaning** from lorrgs `add_trinket` (Strength/Agility/Int spec sets, "allied deaths reduce this cooldown by 30 s"); most-used trinkets among top-100 parses (WoWAnalyzer's EncounterStats pattern).
- **Embellishment/trinket proc rates** matched by `bonusIDs`.
- **Ready Check score** (Wipefest: averageGems, averageSet, averageWorldBuffs).

### I. Raid-level context and rankings

- **Speed and Execution in one call.** `Report.rankings(fightIDs, playerMetric)` returns the kill's speed rank/percentile, execution rank/percentile ("rewards minimizing deaths and damage taken"), deaths, non-tank damage taken, ilvl bracket, and every player's parse %, ilvl-bracket parse %, rank and total parses. ~2–3 database points. This is the Ranks tab and the Speed/Execution leaderboard.
- **Top kills as a raid comparison set.** `Encounter.fightRankings(metric: speed|execution)` rows carry duration, damage taken, deaths, healer/melee/ranged counts, raid ilvl. We derive raid comparisons from the per-spec pool's fights.
- **Raid item level.** `averageItemLevel`, `friendlyItemLevels[]`, `friendlySpecs[]` on the fight (sampled raid 324.2 vs top-30 kills 328.9). The ilvl bracket table (`Zone.brackets`: bracket 18 = ilvl 323–325) explains "ilvl parse".
- **Player history.** `characterData.character.encounterRankings` (best, median, total kills, fastest kill, locked-in parse, by-bracket parse) and `zoneRankings` (all-stars points, per-boss medians). "This was your 2nd kill; best 182 k, 73rd percentile, median 60."
- **Guild progress.** Raider.IO public API (`guilds/profile?fields=raid_progression`, `raiding/raid-rankings` with world-first dates); terms bar commercial use without permission. WCL `Guild.zoneRanking.progress/speed` and `reportData.reports(guildID)` for multi-night trends.
- **Hotfix dates.** Blizzard's hotfix posts are machine-readable via the forum's Discourse JSON (`us.forums.blizzard.com/en/wow/t/2336376.json`), with per-boss bullets ("Spectral Coils damage reduced by 20 % on Heroic and Mythic", 6 Oct 2026). "This pull predates the nerf."
- **Mythic-only / difficulty** from the addons (item A above), so Heroic reviews never mention Mythic mechanics.
- **Raid-wide buffs missing** from combatantInfo auras.
- **Combat res usage, Heroism timing, taunt cadence, healing/raid-cooldown cadence, pre-pot count** are all Wipefest timeline event groups we do not compute.
- **Boss portrait and loot** from the journal's `creatures[].creature_display` → render.worldofwarcraft.com, `items[]`, and instance media.
- **`inProgress` / `archiveStatus`** to refuse a still-uploading or archived report with a clear message.
- **`talentImportCode(actorID)`** on the fight gives an in-game import string for any player, including pool members; we rebuild loadout strings ourselves.

### J. Mechanic depth (Wipefest)

- **Unhandled insight types** across all raids: aggregate 41, custom 26, phaseDuration 24, death 19, reportComponent 17, stackThreshold 17, hitFriendly 16, debuffFriendly 1, diedFromNothing 1, causticGlobule 1 (162 of 3,138, 5 %). In the current raid: custom 1, causticGlobule 1, reportComponent 7.
- **reportComponent is where the current raid's depth lives**: Coiled Altar "Cleared N Coalesced Venom orbs with Sever", "Mutagenic Venom explosions", "orbs remaining at end of Stage One"; Entombed Sentinels "Helical Toxin incorrect additions"; Ula'tek "Eggs broken early"; Fractillus wall-placement map; Salhadaar beam baits. Opaque hosted code; each needs a hand-written rule from WCL events.
- **custom** keys are server-side: readyCheck, potions, ovinaxEggs, manifestMatrices, causticGlobule ("Failed to soak a Caustic Globule before it expired"), factionChampionsKillOrder. Title and require ids visible only.
- **Percentiles without a pool.** `GET /statistics/buckets?boss=` (public, 1.15 MB) gives 101 percentile buckets per insight × statistic × difficulty. "Your 39.1 K damage per raid member on Kith'ix sits at the 30th percentile." `GET /statistics/top/{boss}` lists the top-10 raids per insight.
- **Per-player scores.** `playerValues[]` with `totalValue` (0–100), bonus, per-insight weighted values; tooltip "the percentile the raid would get if everyone performed like this player". `playerValue.value` expressions and weight magnitudes (raid deaths −1,000,000) in the config feed it; we read only the sign.
- **Fight score** (`percentile`, 66.9 on a sampled kill), insight `weight` (Deaths 62.9, Kith'ix H 95.2).
- **Typed detail payloads** we never render: timelines, stackResetsTable, playersAndDurationsOverThreshold, abilitiesAndTimestamps, annotated map frames.
- **Mythic Trap guide embeds.** 1,966 insights carry `tipEmbedUrl` (`mythictrap.com/en/embed-ability/…`): a free per-mechanic guide link per card. Wipefest's own Guide tab is a Mythic Trap iframe.
- **Title tokens we leave blank**: {abilityIcon}, {totalEvents}, {role}, {phase}, {stacks}, {source}, {targets}.
- **Unqueried event types in configs**: resurrect (combat res), energize, resourcechange/drain, instakill, aurabroken; `miss`/`immune`/`absorb` wanted as hits by some soak configs (Fyrakk, Baleroc) but dropped by our NON_HITS filter.
- **Character and guild endpoints**: `/character/{region}/{realm}/{name}/parses` (a player's Wipefest history), `/v2/guild/.../reports` (averageTimeBetweenWipes, percentTimeEngagedInEncounters). Multi-pull analysis endpoints are subscriber-only (401).
- **Swagger** at `api.wipefest.gg/swagger/v0.1/swagger.json`; `markupFormat=Text` and `insightsOnly=true` make the compare harness cheaper.

### K. Multi-pull and progression (every rival has some of this; we are single-pull)

- Pull-by-pull chart with wipe tags (close/enrage/early), streaks, best pull (Azeroth Logs).
- Recurring deaths grouped by mechanic across pulls; "same player dies first" (Azeroth Logs, WowCoach guild trends, WCL Survivability table).
- Average casts per pull and cross-pull trend rows (Viserio).
- Raid-night time accounting: combat vs trash vs setup, biggest gap, clear speed (Viserio Raid Logs).
- Planned vs actual cooldown assignments and compliance grids (Viserio, Azeroth Logs). Needs a plan as input.
- Interrupt attribution across the raid: which casts completed and who could have kicked (WowCoach; WCL `interrupt{extraAbilityGameID}`).

### L. Presentation and phrasing worth borrowing

- WoWAnalyzer's four tiers with plain definitions: Perfect "did the mechanic perfectly", Good "correctly", Ok "suboptimally, but not a big deal", Fail "incorrectly"; per-cast boxes coloured by tier with a one-line tooltip and checklist rows; "hide good casts" toggle.
- Role-aware sections: melee get melee uptime, healers get healing uptime and mana, casters get cancelled casts.
- DBM `RegisterAltSpellName` and BigWigs `SetRenames` give short semantic labels beyond our 14-type enum: "Tank Line", "Group Soak", "Tank Buster", "Platform Break", "Big Circle", "Tank Combo", "Pools", "Orbs", "Tank Frontal", "Mind Control", "dodge", "adds spawning". BigWigs severity (`AddSounds`: alarm/warning/alert/info) orders what the authors treat as dangerous.
- Journal content we flatten: stage headers with text, add sections, parent → child ability nesting (Hungering Pyre → Slithering Flame, Cremation), role-specific Overview bullets keyed to the viewer's role.
- Honest caveats to copy: "limited to the combat log; no way to know if you were holding for a burn phase or doing something the strat required"; "potential cast went unused, but may have been saved for a mechanic"; "mana guideline is just a guideline"; downtime suppressed when GCD tracking is inaccurate; no gear/talent data without Advanced Combat Logging.
- Human-reviewer checks no tool automates: pick the right pull; order the deaths and decide "mechanics or throughput" before judging anyone; check Done-to-Enemy for padding; compare like-for-like (trinkets, fight length, ilvl, patch date); verify assignments (soaker soaked, swaps on time, healer CDs staggered); holding a spell for a buff is fine up to 2–3 GCDs; write down only 1–3 actionable differences.

### M. Sources, terms and freshness

| Source | What it gives | Terms |
|---|---|---|
| lorrgs (github gitarrg/lorrgs, api2.lorrgs.io) | spec/boss spell tables, externals, potions, trinkets, racials, phases, top-50 pools | README says MIT; no LICENSE file; no API terms. Our scratch "LICENSE" is a 404 page. Ask the maintainer before depending on the API. |
| WoWAnalyzer (branch `midnight`, pushed 2026-10-24) | thresholds, formulas, normalisers, phrasing | AGPL-3.0: semantics may be re-implemented; paraphrase, never copy code or sentences. 16 specs fully maintained, 6 foundation-only, Prot Paladin unmaintained. |
| Wipefest (api.wipefest.gg) | configs for 227 encounters, buckets, top tables, per-player scores | Public API, no auth; multi-pull analysis subscriber-only. Wipefest.Core is AGPL (semantics only). |
| Warcraft Logs v2 | everything in sections A, B, E, H, I | 18,000 points/hour plus a separate database-points budget (`rateLimitData.databaseLimitPerHour`). |
| DBM | timers, stage triggers, alt names, aura-sound comments, Mythic flags | "All Rights Reserved". Derived facts and credit only. |
| BigWigs | gap timers, SetAuraData notes, renames, stage tabs, severity | "All Rights Reserved: free to fork and modify on GitHub, please ask us about anything else." Facts and credit only. |
| Blizzard journal API | stages, adds, nesting, role tips, creatures, loot, media | Developer portal terms; attribution expected. |
| Wowhead | tooltip JSON (icon, buff, rppm, scaled values), spell page details (cast time, school, range), per-build changelog | ToS JS-rendered, UNVERIFIED; spell pages rate-limit after ~10 requests, tooltip endpoint stable. |
| Blizzard hotfix forum JSON | dated per-boss tuning notes | Short quotes with link; terms UNVERIFIED. |
| Raider.IO API | guild progression, world-first dates | Non-commercial only without written permission. |
| Method guides | per-boss strategy text, updated 11 Aug 2026 | Copyright Method; link, do not quote at length. |

## 3. Ranked shortlist

Ordered by how much accuracy or new truth each buys per unit of work, inside the no-rulebook rule.

1. **Fix list in section 1** (Wipefest 400 caching, phase ids, excludeCastTarget, grace windows, threshold averaging, lorrgs show flag and TANK tag, externals query, DBM id aliases). Half of these are one-line changes.
2. **Named boss casts on the timeline** (lorrgs boss files + one enemy-cast query) and **real phase names, lastPhase and bossPercentage** (free fields on queries we already make).
3. **Externals, Power Infusion, Innervate, Bloodlust** (one targetID buffs/debuffs table): unlocks death rows ("no external on you"), lust alignment, and PI timing.
4. **Cast efficiency numbers** ("2 of 3 possible uses") using WoWAnalyzer's formula with our Wowhead cooldowns, and **pre-pull detection** from combatantInfo auras.
5. **Wipefest percentiles from the buckets endpoint** on every mechanic card, plus the `death` and `stackThreshold` insight types, and the Nth-death interval control.
6. **Consequence-debuff explanations** from BigWigs SetAuraData and DBM aura comments.
7. **Ability cadence per stage** from BigWigs gap tables: "N chances, hit by M".
8. **Speed/Execution/parse context** from `Report.rankings` and the player's own history from `encounterRankings`.
9. **Preparation depth** from data already fetched: enchant rank, tier count, sockets, auras at pull, potion count vs possible.
10. **GCD-based downtime, cancelled casts, melee uptime, raid-wide idle windows** (needs begincast events and a per-spell GCD table).
11. **Healer mana pacing and overheal vs pool.**
12. **Defensive value** ("absorbed 38 % of your HP") from mitigated/unmitigated fields.
13. **Hotfix-date awareness** and **Mythic Trap links** on mechanic cards.
14. **Multi-pull progression** (the one area every rival has and we lack entirely).
