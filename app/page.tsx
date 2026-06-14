import React from 'react';
import Link from 'next/link';
import NewFeature from '../components/NewFeature';

const BLIZZARD_ID_FALLBACK = "0c3b0342c95545afb8d295a11a88d4c5";
const BLIZZARD_SECRET_FALLBACK = "11XEP5fxFLSs65GUmiGjLLgUdnCEhx4r";

async function getWclToken() {
  const response = await fetch('https://www.warcraftlogs.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.WCL_CLIENT_ID || '',
      client_secret: process.env.WCL_CLIENT_SECRET || '',
    }),
    next: { revalidate: 3600 }
  });
  if (!response.ok) throw new Error('Failed WCL Authentication');
  const data = await response.json();
  return data.access_token;
}

async function getBlizzardToken() {
  let clientId = process.env.BLIZZARD_CLIENT_ID || BLIZZARD_ID_FALLBACK;
  let clientSecret = process.env.BLIZZARD_CLIENT_SECRET || BLIZZARD_SECRET_FALLBACK;

  if (clientId.startsWith('PASTE_YOUR') || clientSecret.startsWith('PASTE_YOUR') || !clientId || !clientSecret) {
    throw new Error('Missing Credentials Exception: Please update your placeholders on lines 5 and 6.');
  }

  const response = await fetch('https://us.battle.net/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
    next: { revalidate: 3600 }
  });
  if (!response.ok) throw new Error('Blizzard OAuth Handshake Declined.');
  const data = await response.json();
  return data.access_token;
}

async function getRaidStructure(token: string) {
  const query = `query { worldData { zones { id name encounters { id name } } } }`;
  const response = await fetch('https://www.warcraftlogs.com/api/v2/client', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const result = await response.json();
  return result.data?.worldData?.zones || [];
}

async function getWclRankings(token: string, bossId: number, className: string, specName: string, difficulty: number, region: string) {
  const wclClassName = className.replace(/\s+/g, '');
  const wclSpecName = specName.replace(/\s+/g, '');

  const query = `
    query {
      worldData {
        encounter(id: ${bossId}) {
          characterRankings(className: "${wclClassName}", specName: "${wclSpecName}", difficulty: ${difficulty}, serverRegion: "${region}")
        }
      }
    }
  `;
  const response = await fetch('https://www.warcraftlogs.com/api/v2/client', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const result = await response.json();
  return result.data?.worldData?.encounter?.characterRankings?.rankings || [];
}

async function getHistoricalFightTelemetry(wclToken: string, reportCode: string, fightId: number, playerName: string) {
  try {
    const query = `
      query {
        reportData {
          report(code: "${reportCode}") {
            masterData { actors(type: "Player") { id name } }
            events(fightIDs: [${fightId}], dataType: CombatantInfo, startTime: 0, endTime: 2147483647) { data }
          }
        }
      }
    `;
    const response = await fetch('https://www.warcraftlogs.com/api/v2/client', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${wclToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });

    const result = await response.json();
    const reportData = result.data?.reportData?.report;
    const actors = reportData?.masterData?.actors || [];
    const events = reportData?.events?.data || [];

    const targetActor = actors.find((a: any) => a.name.toLowerCase() === playerName.toLowerCase());
    const matchedSourceId = targetActor ? targetActor.id : null;
    const targetedCombatantEvent = events.find((e: any) => e.sourceID === matchedSourceId) || null;

    // --- STEP 1: INSERT DEBUG LOGS HERE ---
    if (targetedCombatantEvent) {
      console.log("SUCCESS! Found telemetry for player:", playerName);
      console.log("Telemetry Structure:", JSON.stringify(targetedCombatantEvent, null, 2));
    } else {
      console.log("Telemetry NOT found for player:", playerName);
    }
    // --------------------------------------

    return {
      sourceId: matchedSourceId,
      event: targetedCombatantEvent
    };
  } catch (e) {
    return { sourceId: null, event: null };
  }
}

async function getTalentTreeLayout(treeId: number, accessToken: string) {
  const url = `https://us.api.blizzard.com/data/wow/talent-tree/${treeId}?namespace=static-us&locale=en_US`;
  
  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });
  
  const data = await response.json();
  // This returns an array of nodes, each with 'display_row' and 'display_col'
  return data.nodes.map((node: any) => ({
    nodeID: node.id,
    row: node.display_row,
    column: node.display_col
  }));
}

const POPULAR_SPECS = [
  { class: 'Death Knight', specs: ['Blood', 'Frost', 'Unholy'], color: 'text-[#C41E3A]', border: 'border-[#C41E3A]/40', activeBg: 'bg-[#C41E3A]/10' },
  { class: 'Demon Hunter', specs: ['Havoc', 'Vengeance', 'Devourer'], color: 'text-[#A330C9]', border: 'border-[#A330C9]/40', activeBg: 'bg-[#A330C9]/10' },
  { class: 'Druid', specs: ['Balance', 'Feral', 'Guardian', 'Restoration'], color: 'text-[#FF7D0A]', border: 'border-[#FF7D0A]/40', activeBg: 'bg-[#FF7D0A]/10' },
  { class: 'Evoker', specs: ['Augmentation', 'Devastation', 'Preservation'], color: 'text-[#33937F]', border: 'border-[#33937F]/40', activeBg: 'bg-[#33937F]/10' },
  { class: 'Hunter', specs: ['Beast Mastery', 'Marksmanship', 'Survival'], color: 'text-[#ABD473]', border: 'border-[#ABD473]/40', activeBg: 'bg-[#ABD473]/10' },
  { class: 'Mage', specs: ['Arcane', 'Fire', 'Frost'], color: 'text-[#3FC7EB]', border: 'border-[#3FC7EB]/40', activeBg: 'bg-[#3FC7EB]/10' },
  { class: 'Monk', specs: ['Brewmaster', 'Mistweaver', 'Windwalker'], color: 'text-[#00FF96]', border: 'border-[#00FF96]/40', activeBg: 'bg-[#00FF96]/10' },
  { class: 'Paladin', specs: ['Holy', 'Protection', 'Retribution'], color: 'text-[#F48CBA]', border: 'border-[#F48CBA]/40', activeBg: 'bg-[#F48CBA]/10' },
  { class: 'Priest', specs: ['Discipline', 'Holy', 'Shadow'], color: 'text-[#FFFFFF]', border: 'border-[#FFFFFF]/40', activeBg: 'bg-[#FFFFFF]/10' },
  { class: 'Rogue', specs: ['Assassination', 'Outlaw', 'Subtlety'], color: 'text-[#FFF468]', border: 'border-[#FFF468]/40', activeBg: 'bg-[#FFF468]/10' },
  { class: 'Shaman', specs: ['Elemental', 'Enhancement', 'Restoration'], color: 'text-[#0070DE]', border: 'border-[#0070DE]/40', activeBg: 'bg-[#0070DE]/10' },
  { class: 'Warlock', specs: ['Affliction', 'Demonology', 'Destruction'], color: 'text-[#8787ED]', border: 'border-[#8787ED]/40', activeBg: 'bg-[#8787ED]/10' },
  { class: 'Warrior', specs: ['Arms', 'Fury', 'Protection'], color: 'text-[#C69B6D]', border: 'border-[#C69B6D]/40', activeBg: 'bg-[#C69B6D]/10' },
];

interface PageProps {
  searchParams: Promise<{ boss?: string; class?: string; spec?: string; difficulty?: string; region?: string; }>;
}

async function fetchCompleteSpecLayoutMatrix(wclToken: string) {
  try {
    // This query asks for the 'gameData' top-level fields
    const query = `
      query {
        gameData {
          classes {
            id
            name
          }
          specs {
            id
            name
            classID
          }
        }
      }
    `;
    
    const response = await fetch('https://www.warcraftlogs.com/api/v2/client', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${wclToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });

    const result = await response.json();
    console.log("DEBUG: Full Schema Dump:", JSON.stringify(result, null, 2));
    return []; 
  } catch (e) { return []; }
}

export default async function Home(props: PageProps) {
  const searchParams = await props.searchParams;
  const activeBossId = searchParams.boss ? parseInt(searchParams.boss) : null;
  const activeClass = searchParams.class || null;
  const activeSpec = searchParams.spec || null;
  const activeDifficulty = searchParams.difficulty ? parseInt(searchParams.difficulty) : 5;
  const activeRegion = searchParams.region || 'US';

let zones = [];
  let detailedRankings: any[] = [];
  let layoutData: any[] = []; // Ensure this line exists here
  let skeletonMap: any[] = []; 
  let error = null;

  try {
    const wclToken = await getWclToken();
    zones = await getRaidStructure(wclToken);

    if (activeBossId && activeClass && activeSpec) {
      // Define the IDs here based on your selection
      const classId = 6; // Death Knight
      const specId = 1;  // Blood
  
      // Call the function with the IDs
      skeletonMap = await fetchCompleteSpecLayoutMatrix(wclToken, classId, specId);
      const normalizedClass = activeClass.replace(/\s+/g, '').toLowerCase(); // "Death Knight" -> "deathknight"
      const normalizedSpec = activeSpec.toLowerCase(); // "Blood" -> "blood"
      console.log("DEBUG: Fetching layout for:", activeClass, activeSpec);

      skeletonMap = await fetchCompleteSpecLayoutMatrix(wclToken, activeClass, activeSpec);

      console.log("DEBUG: skeletonMap received", skeletonMap);

      const rawRankings = await getWclRankings(wclToken, activeBossId, activeClass, activeSpec, activeDifficulty, activeRegion);
      
      detailedRankings = await Promise.all(
        rawRankings.slice(0, 4).map(async (player: any) => {
          const telemetryData = await getHistoricalFightTelemetry(wclToken, player.report?.code, player.report?.fightID, player.name);
          // You return the data here, attaching it to 'telemetry'
           return { ...player, telemetry: telemetryData };
         })
      );
    }
  } catch (err: any) {
    error = err.message;
  }

  const MIDNIGHT_RAIDS = ["VS / DR / MQD"];
  const activeRaids = zones.filter((z: any) => z.encounters && z.encounters.length > 0 && MIDNIGHT_RAIDS.includes(z.name));

  const currentClassObj = POPULAR_SPECS.find((c) => c.class === activeClass);

  const getFilterUrl = (overrides: { boss?: number | null; class?: string | null; spec?: string | null; difficulty?: number; region?: string }) => {
    const b = overrides.boss !== undefined ? overrides.boss : activeBossId;
    const c = overrides.class !== undefined ? overrides.class : activeClass;
    const s = overrides.spec !== undefined ? overrides.spec : activeSpec;
    const d = overrides.difficulty !== undefined ? overrides.difficulty : activeDifficulty;
    const r = overrides.region !== undefined ? overrides.region : activeRegion;

    let params = [];
    if (r) params.push(`region=${r}`);
    if (d) params.push(`difficulty=${d}`);
    if (b) params.push(`boss=${b}`);
    if (c) params.push(`class=${encodeURIComponent(c)}`);
    if (s) params.push(`spec=${encodeURIComponent(s)}`);
    return params.length > 0 ? `?${params.join('&')}` : '?';
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans flex flex-col antialiased selection:bg-amber-500/30">
      {/* Header */}
      <header className="border-b border-zinc-800/80 bg-zinc-900/40 backdrop-blur-md px-8 py-4 flex flex-col md:flex-row gap-4 justify-between items-center shrink-0 shadow-sm sticky top-0 z-50">
        <div className="flex items-center space-x-3.5">
        <div className="h-2.5 w-2.5 rounded-full bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)] animate-pulse" />
        <h1 className="text-xl font-black tracking-tight text-zinc-50">
           HOTSBB<span className="text-amber-500 font-medium"> RAID TALENTS FINDER</span>
        </h1>
      </div>

        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center p-0.5 bg-zinc-950/80 rounded-xl border border-zinc-800/80 shadow-inner">
            {['US', 'EU'].map((r) => (
              <Link
                key={r}
                href={getFilterUrl({ region: r })}
                className={`px-4 py-1 rounded-lg text-xs font-bold transition-all ${
                  activeRegion === r 
                    ? 'bg-zinc-800 text-amber-400 font-black shadow-md border border-zinc-700/50' 
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {r}
              </Link>
            ))}
          </div>

          <div className="flex items-center p-0.5 bg-zinc-950/80 rounded-xl border border-zinc-800/80 shadow-inner">
            <Link href={getFilterUrl({ difficulty: 4 })} className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${activeDifficulty === 4 ? 'bg-gradient-to-r from-amber-500 to-amber-600 text-zinc-950 font-black shadow' : 'text-zinc-500 hover:text-zinc-300'}`}>Heroic</Link>
            <Link href={getFilterUrl({ difficulty: 5 })} className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${activeDifficulty === 5 ? 'bg-gradient-to-r from-purple-600 to-fuchsia-600 text-zinc-50 font-black shadow' : 'text-zinc-500 hover:text-zinc-300'}`}>Mythic</Link>
          </div>
        </div>
      </header>

      {/* Main Grid Frame */}
      <div className="flex-1 grid grid-cols-1 md:grid-cols-4 gap-6 p-6 max-w-7xl w-full mx-auto overflow-hidden items-start">
        
        {/* SIDEBAR: Classes console */}
        <aside className="md:col-span-1 bg-zinc-900/30 backdrop-blur-sm border border-zinc-800/60 rounded-2xl p-4 md:sticky md:top-24 h-fit max-h-[calc(100vh-120px)] flex flex-col shadow-lg overflow-hidden">
          <h2 className="text-xs font-bold uppercase tracking-widest text-zinc-500 px-2 mb-4 shrink-0 flex items-center justify-between">
            <span>Select Class</span>
            <span className="text-[10px] font-mono bg-zinc-800 px-1.5 py-0.5 rounded text-zinc-400">CORE</span>
          </h2>
          
          <div className="space-y-1 overflow-y-auto pr-1 flex-1 custom-scrollbar">
            {POPULAR_SPECS.map((cls) => {
              const isClassSelected = activeClass === cls.class;
              return (
               <Link
                  key={cls.class}
                    href={getFilterUrl({ class: cls.class, spec: null, boss: null })}
                    className={`block w-full text-left text-sm py-2 px-3 rounded-xl transition-all border font-medium ${cls.color} ${
        isClassSelected 
          ? `${cls.activeBg} ${cls.border} font-black shadow-sm border-opacity-100` 
          : 'border-transparent hover:bg-zinc-900/40 hover:border-zinc-800'
      }`}
    >
      {/* ADDED: Color-coded indicator bullet */}
      <span className={`inline-block w-1.5 h-1.5 rounded-full mr-2 ${cls.color.replace('text-', 'bg-')}`} />
      {cls.class}
    </Link>
  );
})}
          </div>
        </aside>

        {/* Right Panel Workspace Canvas */}
        <main className="md:col-span-3 flex flex-col space-y-6 min-h-0 w-full">
          {error && (
            <div className="bg-red-950/50 border border-red-800/60 text-red-200 p-5 rounded-2xl shadow-lg shrink-0">
              <p className="font-semibold text-md mb-1">System Exception Caught</p>
              <pre className="text-xs opacity-90 font-mono bg-zinc-950 p-3 rounded border border-red-900 text-red-400 whitespace-pre-wrap select-all">{error}</pre>
            </div>
          )}

          {!activeClass ? (
            <div className="bg-zinc-900/10 border border-dashed border-zinc-800 p-12 rounded-2xl text-center text-zinc-500 flex flex-col items-center justify-center space-y-3">
              <div className="h-10 w-10 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center text-amber-500 font-bold shadow text-lg">✦</div>
              <h3 className="text-zinc-200 font-bold text-md">Raid Talents Finder</h3>
              <p className="text-xs text-zinc-500 max-w-sm leading-relaxed">
                Pick your class and spec to find the top parses for each class. Click the link to find the WCL with an import feature for their talents.
              </p>
            </div>
          ) : (
            <>
              {/* STAGE 1: Specialization Selection Grid */}
              <div className="space-y-3 shrink-0">
                <h2 className="text-xs font-bold uppercase tracking-widest text-zinc-500 px-1">1. Choose Your Spec</h2>
                <div className="bg-zinc-900/30 backdrop-blur-sm border border-zinc-800/60 rounded-2xl p-5 shadow-lg">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {currentClassObj?.specs.map((spec) => {
                      const isSpecSelected = activeSpec === spec;
                      return (
                        <Link
                          key={spec}
                          href={getFilterUrl({ spec: spec, boss: null })}
                          className={`block p-4 rounded-xl text-center cursor-pointer transition-all border text-sm font-semibold ${
                            isSpecSelected ? `${currentClassObj.activeBg} ${currentClassObj.border} ${currentClassObj.color} font-black shadow-md` : 'bg-zinc-950/40 border-zinc-800/60 text-zinc-300 hover:bg-zinc-900/50 hover:border-zinc-700/60'
                          }`}
                        >
                          {spec}
                        </Link>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* STAGE 2: Raid Encounter Selection */}
              {activeSpec && (
                <div className="space-y-3 shrink-0">
                  <h2 className="text-xs font-bold uppercase tracking-widest text-zinc-500 px-1">2. Pick Your Boss</h2>
                  <div className="grid grid-cols-1 gap-6">
                    {activeRaids.map((raid: any) => (
                      <div key={raid.id} className="bg-zinc-900/30 backdrop-blur-sm border border-zinc-800/60 rounded-2xl p-5 shadow-lg">
                        <div className="flex items-center justify-between border-b border-zinc-800/80 pb-3 mb-4">
                          <h3 className="text-sm font-black uppercase tracking-wider text-amber-500/90">
                            Midnight Raid Bosses
                          </h3>
                          <span className="text-[10px] font-mono text-zinc-600 bg-zinc-950 px-2 py-0.5 rounded border border-zinc-900">
                            {raid.name}
                          </span>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                          {raid.encounters.map((boss: any) => {
                            const isSelected = activeBossId === boss.id;
                            return (
                              <Link 
                                key={boss.id} 
                                href={getFilterUrl({ boss: boss.id })} 
                                className={`block p-3.5 rounded-xl text-left cursor-pointer transition-all border relative overflow-hidden group ${
                                  isSelected ? 'bg-zinc-900 border-amber-500/80 shadow-md text-amber-400 font-extrabold shadow-[0_0_15px_rgba(245,158,11,0.05)]' : 'bg-zinc-950/40 border-zinc-800/60 text-zinc-300 hover:bg-zinc-900/50 hover:border-zinc-700/60'
                                }`}
                              >
                                <div className="flex flex-col h-full justify-between space-y-3">
                                  <span className={`text-sm tracking-tight font-semibold line-clamp-2 leading-snug ${isSelected ? 'text-amber-400' : 'text-zinc-200 group-hover:text-amber-500/90 transition-colors'}`}>{boss.name}</span>
                                  <span className={`text-[9px] font-mono tracking-wider block ${isSelected ? 'text-zinc-500' : 'text-zinc-600 group-hover:text-zinc-500'}`}>ID: {boss.id}</span>
                                </div>
                              </Link>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* STAGE 3: Performance Records Output */}
              <div className="space-y-3 w-full">
                <div className="flex justify-between items-center px-1">
                  <h2 className="text-xs font-bold uppercase tracking-widest text-zinc-500">
                    3. Top Parses
                  </h2>
                </div>

                <div className="bg-zinc-900/30 backdrop-blur-sm border border-zinc-800/80 rounded-2xl p-6 shadow-xl space-y-4 w-full">
                  {activeBossId && activeSpec ? (
                    detailedRankings.length === 0 ? (
                      <div className="p-8 bg-zinc-950/40 rounded-xl border border-zinc-800/60 text-center text-sm text-zinc-500 italic">
                        No performance snapshots matched this parameter set for {activeRegion}.
                      </div>
                    ) : (
                      detailedRankings.map((player: any, idx: number) => {
  return (
    <div key={idx} className="bg-zinc-950/50 border border-zinc-800/60 p-5 rounded-xl flex flex-col gap-4 shadow-sm group">
      {/* HEADER: Name and prominent WCL Link */}
      <div className="flex justify-between items-center border-b border-zinc-900 pb-3">
        <span className="font-bold text-lg text-zinc-100">{player.name}</span>
        
        <a 
          href={`https://www.warcraftlogs.com/reports/${player.report?.code}#fight=${player.report?.fightID}&source=${player.telemetry?.sourceId}`} 
          target="_blank" 
          className="flex items-center gap-2 px-4 py-2 bg-amber-500 hover:bg-amber-400 text-zinc-950 font-black rounded-lg transition-all shadow-[0_0_15px_rgba(245,158,11,0.3)] text-[11px] uppercase tracking-wider"
        >
          Get Raid Talents ↗
        </a>
      </div>

      {/* Blueprint Visuals */}
      <NewFeature 
        telemetry={player.telemetry} 
        layout={skeletonMap || []} 
        colors={{ 
          color: currentClassObj?.color || 'text-zinc-500', 
          border: currentClassObj?.border || 'border-zinc-800', 
          activeBg: currentClassObj?.activeBg || 'bg-zinc-800' 
        }}
      />
      
      {/* Footer Output */}
      <div className="pt-3 border-t border-zinc-900 flex justify-between items-center">
        <div className="text-[11px] font-mono text-zinc-400">
          DPS: <span className="text-emerald-400 font-bold text-sm">{Math.round(player.amount).toLocaleString()}</span>
        </div>
      </div>
    </div>
  );
})
                    )
                  ) : (
                    <div className="p-6 text-center text-sm text-zinc-500 italic flex flex-col items-center justify-center space-y-1.5">
                      <span>Awaiting encounter selection parameters to populate logs.</span>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}