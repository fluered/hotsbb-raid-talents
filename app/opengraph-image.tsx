import { ImageResponse } from 'next/og';

export const alt = 'HotsBB Talents — meta talent builds, spec tier lists and an in-game addon for WoW raids and Mythic+';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function Image() {
  return new ImageResponse(
    <div
      style={{
        display: 'flex',
        width: '100%',
        height: '100%',
        backgroundColor: '#0a0a0a',
        padding: '64px 72px',
        flexDirection: 'column',
        justifyContent: 'center',
        position: 'relative',
        overflow: 'hidden',
        fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif',
      }}
    >
      {/* Amber radial glow top-right */}
      <div
        style={{
          position: 'absolute',
          top: -320,
          right: -320,
          width: 900,
          height: 900,
          borderRadius: '50%',
          background:
            'radial-gradient(circle, rgba(245,158,11,0.13) 0%, rgba(245,158,11,0.04) 45%, transparent 65%)',
          display: 'flex',
        }}
      />

      {/* Subtle bottom-left accent */}
      <div
        style={{
          position: 'absolute',
          bottom: -200,
          left: -200,
          width: 500,
          height: 500,
          borderRadius: '50%',
          background:
            'radial-gradient(circle, rgba(139,92,246,0.06) 0%, transparent 60%)',
          display: 'flex',
        }}
      />

      {/* Brand chip */}
      <div style={{ display: 'flex', marginBottom: 40 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            backgroundColor: 'rgba(245,158,11,0.12)',
            border: '1.5px solid rgba(245,158,11,0.28)',
            borderRadius: 8,
            padding: '7px 18px',
            color: '#f59e0b',
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: 4,
            textTransform: 'uppercase',
          }}
        >
          HotsBB
        </div>
      </div>

      {/* Main title */}
      <div
        style={{
          color: '#ffffff',
          fontSize: 90,
          fontWeight: 900,
          lineHeight: 1,
          letterSpacing: -2,
          marginBottom: 20,
          display: 'flex',
        }}
      >
        HotsBB Talents
      </div>

      {/* Amber divider */}
      <div
        style={{
          width: 72,
          height: 4,
          backgroundColor: '#f59e0b',
          borderRadius: 2,
          marginBottom: 28,
          display: 'flex',
        }}
      />

      {/* Tagline */}
      <div
        style={{
          color: '#71717a',
          fontSize: 26,
          fontWeight: 400,
          lineHeight: 1.4,
          maxWidth: 720,
          display: 'flex',
          flexWrap: 'wrap',
        }}
      >
        Meta talent builds and spec tier lists from top parses, per boss, per dungeon, per spec.
      </div>

      {/* What the site does */}
      <div style={{ display: 'flex', gap: 12, marginTop: 34 }}>
        {['Raid builds', 'Mythic+ builds', 'Tier lists', 'In-game addon'].map(f => (
          <div
            key={f}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              backgroundColor: 'rgba(255,255,255,0.04)',
              border: '1.5px solid rgba(255,255,255,0.1)',
              borderRadius: 999,
              padding: '9px 20px',
              color: '#d4d4d8',
              fontSize: 19,
              fontWeight: 600,
            }}
          >
            <div style={{ display: 'flex', width: 8, height: 8, borderRadius: 4, backgroundColor: '#f59e0b' }} />
            {f}
          </div>
        ))}
      </div>

      {/* Bottom domain */}
      <div
        style={{
          position: 'absolute',
          bottom: 52,
          right: 72,
          color: '#3f3f46',
          fontSize: 17,
          fontWeight: 500,
          display: 'flex',
        }}
      >
        hotsbbtalents.io
      </div>
    </div>,
    { ...size }
  );
}
