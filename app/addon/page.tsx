import React from 'react';
import Link from 'next/link';
import type { Metadata } from 'next';
import SiteFooter, { ADDON_RELEASES_URL, ADDON_REPO_URL } from '../../components/SiteFooter';
import SiteShell from '../../components/SiteShell';
import { ogImageMeta } from '../../lib/ogImage';

// Static install guide for the in-game addon. Linked from every page header, the
// homepage card and the footer; the GitHub release itself stays the download source.

const ZIP_URL = 'https://github.com/fluered/hotsbb-raid-talents/releases/latest/download/HotsBBTalents.zip';
const WOWUP_URL = 'https://wowup.io';

const title = 'HotsBB Talents Addon — Install with WowUp | HotsBB';
const description = 'Get every meta talent build from this site inside World of Warcraft. Install the HotsBB Talents addon with WowUp in two minutes, or manually, and import boss and dungeon builds with one click.';

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: 'https://hotsbbtalents.io/addon' },
  ...ogImageMeta({
    title, description,
    imageTitle: 'In-game Addon',
    subtitle: 'One-click meta builds for every boss and dungeon',
    kicker: 'Install with WowUp',
  }),
};

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-4">
      <span className="flex-shrink-0 w-7 h-7 rounded-full bg-amber-500/15 border border-amber-500/40 text-amber-300 text-xs font-black flex items-center justify-center mt-0.5">{n}</span>
      <div className="space-y-1 min-w-0">
        <p className="font-bold text-zinc-100">{title}</p>
        <div className="text-sm text-zinc-400 leading-relaxed">{children}</div>
      </div>
    </li>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="font-mono text-[13px] text-amber-200 bg-zinc-900 border border-zinc-800 rounded px-1.5 py-0.5 break-all">{children}</code>;
}

export default function AddonPage() {
  const breadcrumbSchema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'HotsBB Raid Talents', item: 'https://hotsbbtalents.io' },
      { '@type': 'ListItem', position: 2, name: 'In-game Addon', item: 'https://hotsbbtalents.io/addon' },
    ],
  };
  const howToSchema = {
    '@context': 'https://schema.org',
    '@type': 'HowTo',
    name: 'Install the HotsBB Talents addon with WowUp',
    totalTime: 'PT2M',
    step: [
      { '@type': 'HowToStep', name: 'Install WowUp', text: 'Download WowUp from wowup.io and open it. It finds your World of Warcraft folder automatically.' },
      { '@type': 'HowToStep', name: 'Install from URL', text: 'Open Get Addons, click Install from URL, paste https://github.com/fluered/hotsbb-raid-talents and click Import, then Install.' },
      { '@type': 'HowToStep', name: 'Open it in game', text: 'Log in (or /reload) and type /hbt. Updates arrive automatically whenever you click Update All in WowUp.' },
    ],
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-zinc-100 font-sans antialiased">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(howToSchema) }} />

      <header className="border-b border-zinc-800/70 bg-black/70 backdrop-blur-md sticky top-0 z-50">
        <div className="px-4 md:px-5 h-12 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Link href="/" className="font-black text-amber-400 tracking-widest uppercase text-xs hover:text-amber-300 transition-colors whitespace-nowrap">
              HotsBB Talents
            </Link>
            <span className="hidden sm:inline text-zinc-700">/</span>
            <span className="hidden sm:inline text-xs font-black text-zinc-300 uppercase tracking-widest">In-game Addon</span>
          </div>
          <a
            href={ADDON_RELEASES_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="px-3 py-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 text-xs font-bold text-amber-300 hover:bg-amber-500/20 transition-colors whitespace-nowrap"
          >Latest release ↗</a>
        </div>
      </header>

      <SiteShell>
      <div className="max-w-screen-md mx-auto px-4 md:px-6 py-8 space-y-10">
        {/* Intro */}
        <section className="space-y-3">
          <p className="text-[10px] font-black text-amber-500/80 uppercase tracking-widest">In-game addon</p>
          <h1 className="text-2xl md:text-3xl font-black text-white tracking-tight">Every build on this site, inside WoW</h1>
          <p className="text-zinc-400 leading-relaxed max-w-2xl">
            <span className="font-bold text-zinc-200">HotsBB Talents</span> shows the meta talent build for your spec on
            each raid boss and Mythic+ dungeon, compares it with the talents you are running, and imports it as a loadout
            with one click. Type <Code>/hbt</Code> in game to open it. The data is the same weekly Warcraft Logs
            snapshot this site uses and updates itself every Tuesday.
          </p>
        </section>

        {/* WowUp */}
        <section className="space-y-5">
          <div className="space-y-1">
            <h2 className="text-lg font-black text-white tracking-tight">Install with WowUp <span className="text-zinc-500 font-semibold">(recommended)</span></h2>
            <p className="text-sm text-zinc-500">Takes about two minutes and keeps the addon updated for you.</p>
          </div>
          <ol className="space-y-5">
            <Step n={1} title="Install WowUp">
              Get it free from{' '}
              <a href={WOWUP_URL} target="_blank" rel="noopener noreferrer" className="text-amber-400 hover:text-amber-300 underline underline-offset-2">wowup.io</a>{' '}
              and open it. It finds your <span className="text-zinc-300">World of Warcraft</span> folder on its own. If you already use WowUp, skip to step 2.
            </Step>
            <Step n={2} title="Add the addon from its GitHub page">
              In WowUp open <span className="text-zinc-300">Get Addons</span>, click <span className="text-zinc-300">Install from URL</span>, paste this address and press <span className="text-zinc-300">Import</span>, then <span className="text-zinc-300">Install</span>:
              <div className="mt-2"><Code>{ADDON_REPO_URL}</Code></div>
              <p className="mt-2 text-zinc-500">Make sure the Retail game version is selected at the top of WowUp.</p>
            </Step>
            <Step n={3} title="Open it in game">
              Log in, or type <Code>/reload</Code> if you were already logged in, then type <Code>/hbt</Code>. There is also a
              button on the Talents screen, one on each Encounter Journal boss page, and a minimap icon.
            </Step>
          </ol>
          <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-4 text-sm text-zinc-400 leading-relaxed">
            <span className="font-bold text-zinc-200">Updates:</span> new builds are published every Tuesday evening after
            the weekly reset. WowUp picks them up like any other addon: click <span className="text-zinc-300">Update All</span>.
            The addon shows how old its data is on the Raid/Dungeons row, so you can tell at a glance.
          </div>
        </section>

        {/* Manual */}
        <section className="space-y-4">
          <h2 className="text-lg font-black text-white tracking-tight">Manual install</h2>
          <ol className="space-y-5">
            <Step n={1} title="Download the zip">
              <a href={ZIP_URL} className="text-amber-400 hover:text-amber-300 underline underline-offset-2">HotsBBTalents.zip</a>{' '}
              (always the newest release).
            </Step>
            <Step n={2} title="Extract it into your AddOns folder">
              Unzip so that the <Code>HotsBBTalents</Code> folder sits directly inside
              <div className="mt-2"><Code>World of Warcraft\_retail_\Interface\AddOns\</Code></div>
              <p className="mt-2 text-zinc-500">The folder must contain <Code>HotsBBTalents.toc</Code>; if you see a folder inside a folder, move the inner one up a level.</p>
            </Step>
            <Step n={3} title="Enable and open">
              Restart the game or <Code>/reload</Code>, check it is ticked in the AddOns list at the character screen, then <Code>/hbt</Code>.
              You will need to repeat the download for every update, which is why WowUp is the easier route.
            </Step>
          </ol>
        </section>

        {/* Using it */}
        <section className="space-y-4">
          <h2 className="text-lg font-black text-white tracking-tight">What you get</h2>
          <ul className="grid sm:grid-cols-2 gap-3 text-sm">
            {[
              ['One card per boss and dungeon', 'The full season roster for your spec, with portraits. Inside a dungeon, or after a boss pull, the right card is highlighted.'],
              ['Import & Apply', 'Creates a loadout named "HBT <boss>" and switches to it. If you already have an identical loadout it just switches.'],
              ['Compare with your talents', 'Each card says "Active build" or how many talents differ. Hover for the list; click Preview to light them up on your talent tree.'],
              ['Hero-tree pills', 'Where a spec runs more than one hero tree, pick the variant. The pill matching your active hero tree is selected by default.'],
              ['Copy and Link', 'The raw Blizzard import string, or a clickable chat link to share a build with your group.'],
              ['Honest about gaps', '"No data yet" means too few top parses this week. A "Heroic" tag means Mythic kills were still thin for that boss, so the Heroic build is shown.'],
            ].map(([h, body]) => (
              <li key={h} className="rounded-xl border border-zinc-800/70 bg-zinc-900/30 p-4 space-y-1">
                <p className="font-bold text-zinc-100">{h}</p>
                <p className="text-zinc-500 leading-relaxed">{body}</p>
              </li>
            ))}
          </ul>
        </section>

        {/* FAQ */}
        <section className="space-y-4">
          <h2 className="text-lg font-black text-white tracking-tight">Questions</h2>
          <dl className="space-y-4 text-sm">
            <div>
              <dt className="font-bold text-zinc-100">Is it safe?</dt>
              <dd className="text-zinc-500 leading-relaxed mt-1">It is a plain Lua addon with no libraries, open source on{' '}
                <a href={ADDON_REPO_URL} target="_blank" rel="noopener noreferrer" className="text-amber-400 hover:text-amber-300 underline underline-offset-2">GitHub</a>.
                It only uses Blizzard&apos;s own talent-loadout API, the same one the Talents panel&apos;s Import button uses.</dd>
            </div>
            <div>
              <dt className="font-bold text-zinc-100">Why does WowUp not find it in search?</dt>
              <dd className="text-zinc-500 leading-relaxed mt-1">It is distributed through GitHub releases rather than CurseForge, so it has to be added once with <span className="text-zinc-300">Install from URL</span>. After that it updates like everything else.</dd>
            </div>
            <div>
              <dt className="font-bold text-zinc-100">My action bars have gaps after importing.</dt>
              <dd className="text-zinc-500 leading-relaxed mt-1">Expected when a build changes which abilities you have, and the same thing happens with Blizzard&apos;s own Import. Drag the new abilities back from the spellbook. Loadouts you already had keep their own bars.</dd>
            </div>
            <div>
              <dt className="font-bold text-zinc-100">Can I delete the loadouts it made?</dt>
              <dd className="text-zinc-500 leading-relaxed mt-1">Yes: <Code>/hbt clean</Code> removes every &quot;HBT …&quot; loadout for your current spec, or delete them one at a time in the Talents panel like any loadout.</dd>
            </div>
          </dl>
        </section>

        <SiteFooter />
      </div>
      </SiteShell>
    </div>
  );
}
