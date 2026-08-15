import { ImageResponse } from 'next/og';
import { NextRequest } from 'next/server';
import { WOW_CLASS_HEX } from '../../../lib/ogImage';

// Renders the per-page Open Graph card (see lib/ogImage.ts for why this is a
// query-param route rather than the opengraph-image file convention). Pure
// local render — no WCL/Blizzard calls — so it stays ungated: OG scrapers
// (Discord, Slack, Twitter) fetch anonymously and must get a real image.
// Visual language mirrors app/opengraph-image.tsx (the static home-page card).

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const title = (searchParams.get('t') ?? 'HotsBB Talents').slice(0, 80);
  const subtitle = (searchParams.get('s') ?? '').slice(0, 120);
  const kicker = (searchParams.get('k') ?? '').slice(0, 60);
  const accent = WOW_CLASS_HEX[searchParams.get('c') ?? ''] ?? '#f59e0b';

  return new ImageResponse(
    (
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
        {/* Accent radial glow top-right, tinted by class color */}
        <div
          style={{
            position: 'absolute',
            top: -320,
            right: -320,
            width: 900,
            height: 900,
            borderRadius: '50%',
            background: `radial-gradient(circle, ${accent}22 0%, ${accent}0a 45%, transparent 65%)`,
            display: 'flex',
          }}
        />
        <div
          style={{
            position: 'absolute',
            bottom: -200,
            left: -200,
            width: 500,
            height: 500,
            borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(139,92,246,0.06) 0%, transparent 60%)',
            display: 'flex',
          }}
        />

        {/* Brand chip */}
        <div style={{ display: 'flex', marginBottom: 36, gap: 12 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
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
          {kicker && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                border: '1.5px solid rgba(255,255,255,0.14)',
                borderRadius: 8,
                padding: '7px 18px',
                color: '#a1a1aa',
                fontSize: 13,
                fontWeight: 700,
                letterSpacing: 3,
                textTransform: 'uppercase',
              }}
            >
              {kicker}
            </div>
          )}
        </div>

        {/* Main title — long spec/boss combos wrap to two lines */}
        <div
          style={{
            color: '#ffffff',
            fontSize: title.length > 26 ? 64 : 84,
            fontWeight: 900,
            lineHeight: 1.05,
            letterSpacing: -2,
            marginBottom: 20,
            display: 'flex',
            flexWrap: 'wrap',
            maxWidth: 1000,
          }}
        >
          {title}
        </div>

        {/* Accent divider */}
        <div
          style={{
            width: 72,
            height: 4,
            backgroundColor: accent,
            borderRadius: 2,
            marginBottom: 26,
            display: 'flex',
          }}
        />

        {subtitle && (
          <div
            style={{
              color: '#71717a',
              fontSize: 26,
              fontWeight: 400,
              lineHeight: 1.4,
              maxWidth: 760,
              display: 'flex',
              flexWrap: 'wrap',
            }}
          >
            {subtitle}
          </div>
        )}

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
      </div>
    ),
    {
      width: 1200,
      height: 630,
      headers: {
        // Scraper- and CDN-friendly: these images only change when we change the design.
        'Cache-Control': 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800',
      },
    }
  );
}
