import { useId } from 'react';

interface BrandLogoProps {
  className?: string;
  /** Draw the rounded app tile behind the mark (header); false = bare mark. */
  tile?: boolean;
  /** Lets the intro find the header logo to glide into. */
  'data-brand-logo'?: boolean;
}

/**
 * The Hopr mark as inline SVG, coloured from CSS variables (see .brand-logo in
 * index.css) so it follows the light / dark theme instead of being a fixed
 * dark tile. Geometry matches public/brand/logo-icon.svg (scripts/build-logo.py).
 */
export default function BrandLogo({ className = '', tile = true, ...rest }: BrandLogoProps) {
  const id = useId().replace(/:/g, '');
  return (
    <svg viewBox="0 0 512 512" className={`brand-logo ${className}`} role="img" aria-label="Hopr" {...rest}>
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse">
          <stop offset="0" style={{ stopColor: 'var(--logo-tile-from)' }} />
          <stop offset="1" style={{ stopColor: 'var(--logo-tile-to)' }} />
        </linearGradient>
        <radialGradient id={`${id}-glow`} cx="410" cy="90" r="360" gradientUnits="userSpaceOnUse">
          <stop offset="0" style={{ stopColor: 'var(--logo-tile-glow)', stopOpacity: 0.42 }} />
          <stop offset="1" style={{ stopColor: 'var(--logo-tile-glow)', stopOpacity: 0 }} />
        </radialGradient>
        <linearGradient id={`${id}-stroke`} x1="130" y1="420" x2="360" y2="150" gradientUnits="userSpaceOnUse">
          <stop offset="0" style={{ stopColor: 'var(--logo-stroke-1)' }} />
          <stop offset=".55" style={{ stopColor: 'var(--logo-stroke-2)' }} />
          <stop offset="1" style={{ stopColor: 'var(--logo-stroke-3)' }} />
        </linearGradient>
        <radialGradient id={`${id}-halo`} cx="0" cy="0" r="70" gradientUnits="userSpaceOnUse">
          <stop offset="0" style={{ stopColor: 'var(--logo-ball-halo)', stopOpacity: 0.5 }} />
          <stop offset="1" style={{ stopColor: 'var(--logo-ball-halo)', stopOpacity: 0 }} />
        </radialGradient>
        <radialGradient id={`${id}-ball`} cx="-12" cy="-14" r="52" gradientUnits="userSpaceOnUse">
          <stop offset="0" style={{ stopColor: 'var(--logo-ball-1)' }} />
          <stop offset=".5" style={{ stopColor: 'var(--logo-ball-2)' }} />
          <stop offset="1" style={{ stopColor: 'var(--logo-ball-3)' }} />
        </radialGradient>
      </defs>
      {tile && (
        <>
          <rect width="512" height="512" rx="116" fill={`url(#${id}-bg)`} />
          <rect width="512" height="512" rx="116" fill={`url(#${id}-glow)`} />
          <rect x="2" y="2" width="508" height="508" rx="114" fill="none" strokeWidth="4" style={{ stroke: 'var(--logo-tile-border)' }} />
        </>
      )}
      <g transform={`translate(256 256) scale(${tile ? 0.94 : 1.3}) translate(-266 -255)`}>
        <g fill="none" stroke={`url(#${id}-stroke)`} strokeWidth="60" strokeLinecap="round">
          <path d="M150 110V400" />
          <path d="M150 290C150 212 204 180 260 180C326 180 362 228 366 304" />
        </g>
        <g transform="translate(370 388)">
          <circle r="70" fill={`url(#${id}-halo)`} />
          <circle r="42" fill={`url(#${id}-ball)`} />
        </g>
      </g>
    </svg>
  );
}
