// Personal defensive cooldowns by name. This is the one hand-kept list in the log
// review: class defensives change about once an expansion, not per patch, and
// nothing in a log says "this is defensive". The top-player pool still has the final
// say on whether a name is in use for a spec, so an entry that stops existing simply
// never matches anything.
//
// Deliberately excludes passives (Soul Leech), rotational mitigation (Ironfur, Shield
// Block, Demon Spikes), stance toggles, damage cooldowns with a defensive side effect,
// and externals cast on others (Pain Suppression, Ironbark) — those are the healer's
// call, not the dying player's. "Had X available" has to mean a button they could
// have pressed.

const DEFENSIVE_NAMES = [
  // Everyone
  'Healthstone', 'Healing potion',
  // Death Knight
  'Anti-Magic Shell', 'Icebound Fortitude', 'Lichborne', 'Vampiric Blood', 'Dancing Rune Weapon', 'Rune Tap', 'Death Pact',
  // Demon Hunter
  'Blur', 'Netherwalk', 'Fiery Brand', 'Soul Immolation', // Soul Immolation: Devourer 1-min self-heal (Wowhead: "healing yourself")
  // Druid
  'Barkskin', 'Survival Instincts', 'Frenzied Regeneration', 'Renewal',
  // Evoker
  'Obsidian Scales', 'Renewing Blaze',
  // Hunter
  'Aspect of the Turtle', 'Survival of the Fittest', 'Exhilaration', 'Fortitude of the Bear',
  // Mage
  'Ice Block', 'Alter Time', 'Greater Invisibility', 'Ice Cold', 'Prismatic Barrier', 'Blazing Barrier', 'Ice Barrier',
  // Monk
  'Fortifying Brew', 'Diffuse Magic', 'Dampen Harm', 'Touch of Karma', 'Zen Meditation',
  // Paladin
  'Divine Shield', 'Divine Protection', 'Blessing of Protection', 'Ardent Defender', 'Guardian of Ancient Kings', 'Sentinel', 'Shield of Vengeance', 'Eye for an Eye', 'Lay on Hands',
  // Priest
  'Dispersion', 'Desperate Prayer', 'Fade',
  // Rogue
  'Cloak of Shadows', 'Feint', 'Evasion', 'Crimson Vial',
  // Shaman
  'Astral Shift', 'Stone Bulwark Totem', 'Earth Elemental',
  // Warlock
  'Unending Resolve', 'Dark Pact', 'Nether Ward',
  // Warrior
  'Shield Wall', 'Last Stand', 'Die by the Sword', 'Enraged Regeneration', 'Spell Reflection', 'Bitter Immunity',
];

export const DEFENSIVES = new Set(DEFENSIVE_NAMES);

// Spells whose second cast is the second half of the same press (Alter Time returns,
// Stasis releases) and absorbs that are re-cast when consumed: neither double presses
// nor charges can be read from their cast times.
export const TWO_STEP = new Set(['Alter Time', 'Stasis', 'Stasis (Store)', 'Stasis (Release)', 'Transcendence', 'Transcendence: Transfer']);
export const isAbsorb = (name: string) => /barrier|shield|ward/i.test(name) && !/divine shield|shield wall|shield block/i.test(name);
export const noChargeModel = (name: string) => TWO_STEP.has(name) || isAbsorb(name);

// Talent replacements: when the build has the replacement, the original is gone.
export const REPLACED_BY: Record<string, string> = { 'Ice Block': 'Ice Cold', 'Guardian of Ancient Kings': 'Sentinel' };

// Utility that is a raid assignment, not a personal rotation: interrupts, dispels,
// taunts. Not everyone needs to kick, so "you cast Rebuke less than top players" is
// not a finding for one player — the raid summary tracks whether the casts that
// matter were stopped at all.
const UTILITY_NAMES = [
  // interrupts
  'Rebuke', 'Kick', 'Pummel', 'Counterspell', 'Mind Freeze', 'Wind Shear', 'Skull Bash', 'Disrupt', 'Spear Hand Strike',
  'Silence', 'Counter Shot', 'Muzzle', 'Quell', 'Solar Beam', "Avenger's Shield", 'Axe Toss', 'Spell Lock', 'Optical Blast', 'Shield Bash',
  // dispels
  'Cleanse', 'Purify', 'Remove Curse', 'Naturalize', 'Detox', 'Purify Spirit', 'Cleanse Spirit', "Nature's Cure", 'Cauterizing Flame',
  'Expunge', 'Dispel Magic', 'Mass Dispel', 'Purify Disease', 'Cleanse Toxins', 'Remove Corruption', 'Poison Cleansing Totem', 'Emergency Salve',
  // taunts
  'Taunt', 'Growl', 'Provoke', 'Hand of Reckoning', 'Dark Command', 'Torment', 'Death Grip', 'Challenging Shout',
  // one person per raid presses these
  'Bloodlust', 'Heroism', 'Time Warp', 'Fury of the Aspects', 'Primal Rage', 'Ancient Hysteria', 'Netherwinds', 'Drums of Deathly Ferocity',
  'Rallying Cry', 'Darkness', 'Anti-Magic Zone', 'Zephyr', 'Mass Barrier', 'Ancestral Guidance', 'Spirit Link Totem', 'Power Word: Barrier',
  'Aura Mastery', 'Divine Hymn', 'Healing Tide Totem', 'Tranquility', 'Revival', 'Restoral', 'Rewind', 'Emerald Communion', 'Evangelism',
  'Innervate', 'Power Infusion', 'Misdirection', 'Tricks of the Trade', 'Blessing of Sacrifice', 'Pain Suppression', 'Ironbark', 'Life Cocoon',
  'Guardian Spirit', 'Lay on Hands', 'Rescue', 'Leap of Faith', 'Rebirth', 'Raise Ally', 'Intercession', 'Soulstone', 'Mass Resurrection',
  'Blessing of Spellwarding', 'Time Dilation',
  // crowd control: pressed when a mechanic asks for it, never on cooldown for damage
  'Blinding Light', 'Hammer of Justice', 'Repentance', 'Turn Evil', 'Shadowfury', 'Mortal Coil', 'Howl of Terror', 'Fear', 'Banish',
  'Psychic Scream', 'Mind Bomb', 'Void Tendrils', 'Psychic Horror', 'Intimidating Shout', 'Storm Bolt', 'Shockwave', 'Capacitor Totem', 'Thunderstorm', 'Hex',
  'Chaos Nova', 'Imprison', 'Sigil of Misery', 'Sigil of Silence', 'Sigil of Chains', 'Ring of Frost', "Dragon's Breath", 'Polymorph', 'Frost Nova',
  'Leg Sweep', 'Ring of Peace', 'Song of Chi-Ji', 'Paralysis', 'Typhoon', 'Mighty Bash', "Ursol's Vortex", 'Incapacitating Roar', 'Cyclone', 'Entangling Roots', 'Mass Entanglement',
  'Binding Shot', 'Scatter Shot', 'Freezing Trap', 'Tar Trap', 'Intimidation', 'Blind', 'Kidney Shot', 'Cheap Shot', 'Gouge', 'Sap', "Gorefiend's Grasp", 'Blinding Sleet', 'Asphyxiate',
  'Sleep Walk', 'Landslide', 'Oppressing Roar', 'Wing Buffet', 'Tail Swipe',
  // racials: neither WCL nor lorrgs count them as a major cooldown, so they are not timeline rows
  'Blood Fury', 'Berserking', 'Arcane Torrent', 'Ancestral Call', 'Fireblood', "Light's Judgment", 'Arcane Pulse', 'Bag of Tricks', 'Bull Rush', 'Haymaker',
  'Spatial Rift', 'Rocket Jump', 'Stoneform', 'Gift of the Naaru', 'Will of the Forsaken', 'Darkflight', 'Escape Artist', 'Every Man for Himself', 'War Stomp', 'Quaking Palm',
  "Regeneratin'", 'Hyper Organic Light Originator',
  // raid buffs and pet / summon housekeeping
  'Battle Shout', 'Arcane Intellect', 'Power Word: Fortitude', 'Mark of the Wild', 'Skyfury', 'Blessing of the Bronze', 'Shadow Resistance Aura',
  'Call Pet 1', 'Call Pet 2', 'Call Pet 3', 'Call Pet 4', 'Call Pet 5', 'Dismiss Pet', 'Mend Pet', 'Revive Pet', 'Feign Death',
  'Summon Imp', 'Summon Voidwalker', 'Summon Felhunter', 'Summon Succubus', 'Summon Felguard', 'Summon Water Elemental', 'Create Healthstone',
  'Create Soulwell', 'Ritual of Summoning', 'Conjure Refreshment', 'Vanish', 'Shadowmeld', 'Stealth', 'Prowl', 'Fel Domination',
];
export const UTILITY = new Set(UTILITY_NAMES);

// Movement: pressed when the fight demands it, not on cooldown. Never a "you never
// used" finding.
const MOVEMENT_NAMES = [
  'Disengage', 'Blink', 'Shimmer', 'Fel Rush', 'Vengeful Retreat', 'Infernal Strike', 'Heroic Leap', 'Charge', 'Intervene',
  'Roll', 'Chi Torpedo', 'Flying Serpent Kick', 'Wild Charge', 'Dash', 'Stampeding Roar', "Death's Advance", 'Wraith Walk',
  'Gust of Wind', "Spiritwalker's Grace", 'Burning Rush', 'Demonic Circle', 'Demonic Circle: Teleport', 'Shadowstep', 'Sprint',
  'Grappling Hook', 'Divine Steed', 'Blessing of Freedom', 'Hover', 'Rescue', 'Leap of Faith', 'Angelic Feather', 'Transcendence',
  'Transcendence: Transfer', "Tiger's Lust", 'Door of Shadows', 'The Hunt', 'Aspect of the Cheetah', 'Ghost Wolf', 'Travel Form', 'Cat Form', 'Moonkin Form', 'Bear Form',
  'Wind Rush Totem',
];
export const MOVEMENT = new Set(MOVEMENT_NAMES);
export const isMovement = (name: string) => MOVEMENT.has(name);
export const isUtility = (name: string) => UTILITY.has(name);

// Baseline (untalented) defensives every character of a class has, so a hunter who
// never pressed Aspect of the Turtle still gets it on their roster.
export const BASELINE_BY_CLASS: Record<string, string[]> = {
  'Death Knight': ['Anti-Magic Shell', 'Icebound Fortitude'],
  'Demon Hunter': ['Blur'],
  'Druid': ['Barkskin'],
  'Evoker': ['Obsidian Scales'],
  'Hunter': ['Aspect of the Turtle', 'Exhilaration'],
  'Mage': ['Ice Block'],
  'Monk': ['Fortifying Brew'],
  'Paladin': ['Divine Shield', 'Divine Protection'],
  'Priest': ['Desperate Prayer', 'Fade'],
  'Rogue': ['Cloak of Shadows', 'Feint', 'Crimson Vial'],
  'Shaman': ['Astral Shift'],
  'Warlock': ['Unending Resolve'],
  'Warrior': ['Die by the Sword'],
};

// Healing potions come in many names; they are one button. Names are registered from
// Wowhead's spell text at review time (restores health); the name test is a fallback.
const KNOWN_HEALING_POTIONS = new Set<string>();
export function registerHealingPotionNames(names: Iterable<string>): void { for (const n of names) KNOWN_HEALING_POTIONS.add(n); }
export const isHealingPotion = (name: string) => KNOWN_HEALING_POTIONS.has(name) || /heal(th|ing) potion/i.test(name);
export const defensiveKey = (name: string) => (isHealingPotion(name) ? 'Healing potion' : /healthstone/i.test(name) ? 'Healthstone' : name);
export const isDefensive = (name: string) => DEFENSIVES.has(defensiveKey(name));

export interface DefensiveState {
  available: string[];
  active: string[];
  // Everything on cooldown at that moment, with how long ago the uses in the current
  // cooldown window were (two entries when both charges were spent).
  onCooldown: Array<{ name: string; charges: number; usedAgoSec: number[] }>;
}

// Which of a player's defensives were ready at second `atSec` of the fight.
// `uses` are cast times (or buff starts), `cooldownSec` the cooldown where known,
// `charges` how many charges the build has (default 1), `activeBands` the buff
// windows where the ability applies one. A charge system recharges one at a time
// from the moment of use, so "ready" is "fewer uses in the last cooldown-length than
// charges". A defensive never used in the pull counts as available only if `owned`
// says the player has it. Unknown cooldown ⇒ skipped unless never used.
export function defensivesAt(
  atSec: number,
  owned: string[],
  uses: Record<string, number[]>,
  cooldownSec: Record<string, number | undefined>,
  charges: Record<string, number | undefined> = {},
  activeBands: Record<string, Array<[number, number]>> = {}
): DefensiveState {
  const out: DefensiveState = { available: [], active: [], onCooldown: [] };
  for (const name of owned) {
    if ((activeBands[name] ?? []).some(([s, e]) => s <= atSec && atSec <= e + 0.5)) { out.active.push(name); continue; }
    const before = (uses[name] ?? []).filter(t => t <= atSec);
    if (before.length === 0) { out.available.push(name); continue; }
    const cd = cooldownSec[name];
    if (cd == null) continue;
    const n = Math.max(1, charges[name] ?? 1);
    const inWindow = before.filter(t => t > atSec - cd).sort((a, b) => b - a);
    if (inWindow.length < n) out.available.push(name);
    else out.onCooldown.push({ name, charges: n, usedAgoSec: inWindow.slice(0, n).map(t => Math.round(atSec - t)) });
  }
  return out;
}

// Shortest gap between two activations across every member of the pool: top players
// press defensives on cooldown often enough that this is a usable cooldown estimate
// when Wowhead's tooltip doesn't state one. Gaps shorter than a fifth of the longest
// gap are treated as a second charge, not a cooldown.
export function minReuseGap(starts: number[][]): number | undefined {
  const gaps: number[] = [];
  for (const s of starts) {
    const sorted = s.slice().sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i] - sorted[i - 1]);
  }
  const real = gaps.filter(g => g >= 5);
  if (!real.length) return undefined;
  const longest = Math.max(...real);
  const plausible = real.filter(g => g >= longest / 5);
  return Math.min(...plausible);
}

// Two presses while the first is still running: the second charge is wasted. The
// window is the buff's own duration when known, else a few seconds.
export function wastedDoublePresses(uses: number[], bands: Array<[number, number]>): Array<{ atSec: number; gapSec: number }> {
  const sorted = uses.slice().sort((a, b) => a - b);
  const duration = bands.length ? Math.max(...bands.map(([s, e]) => e - s)) : 0;
  const window = Math.max(4, Math.min(duration || 0, 20));
  const out: Array<{ atSec: number; gapSec: number }> = [];
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap > 0 && gap <= window * 0.8) out.push({ atSec: sorted[i - 1], gapSec: Math.round(gap * 10) / 10 });
  }
  return out;
}

// Usage proves charges: the most uses one player fit inside one cooldown length.
// `minPlayers` guards inference from other people's logs — one top player with a
// cooldown-reset talent must not give everyone a second charge.
export function chargesFromUsage(starts: number[][], cooldownSec: number | undefined, minPlayers = 1): number {
  if (!cooldownSec) return 1;
  const perPlayer: number[] = [];
  for (const s of starts) {
    const sorted = s.slice().sort((a, b) => a - b);
    let best = 1;
    for (let i = 0; i < sorted.length; i++) {
      let n = 1;
      // Only a press inside HALF the cooldown proves a charge; a reduced-cooldown talent
      // can explain anything closer to the full length.
      for (let j = i + 1; j < sorted.length && sorted[j] - sorted[i] < cooldownSec * 0.5; j++) n++;
      if (n > best) best = n;
    }
    perPlayer.push(best);
  }
  for (let charges = 2; charges >= 2; charges--) {
    if (perPlayer.filter(x => x >= charges).length >= minPlayers) return charges;
  }
  return 1;
}

// Talent text proves charges too: "Survival of the Fittest gains an additional charge".
export function chargesFromTalents(name: string, takenTalentDescriptions: string[]): number {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${esc}[^.]*?(additional|extra|second|1 more)\\s+charge|${esc}[^.]*?\\b2 charges`, 'i');
  return takenTalentDescriptions.some(d => re.test(d)) ? 2 : 1;
}
