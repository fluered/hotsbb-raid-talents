import { ImageResponse } from 'next/og';

export const alt = 'HotsBB Raid Talents — Meta talent builds for every WoW Mythic boss';
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
        Raid Talents
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
        Consensus talent builds & meta gear from top Mythic parses — per boss, per spec.
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
        hotsbb.gg
      </div>
    </div>,
    { ...size }
  );
}
