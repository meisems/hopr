import { memo } from 'react';

interface ChainLogoProps {
  chainKey: string;
  size?: number;
  className?: string;
}

// Real SVG chain logos based on official brand assets
const ChainLogo = memo(({ chainKey, size = 24, className = '' }: ChainLogoProps) => {
  const s = size;
  const officialAsset = {
    sol: '/brand/chains/sol.svg',
    arb: '/brand/chains/arbitrum.svg',
    bsc: '/brand/chains/bsc.svg',
    rhc: '/brand/chains/rhc.svg',
    arc: '/brand/chains/arc.jpg',
  }[chainKey];

  if (officialAsset) {
    return <img src={officialAsset} width={s} height={s} alt={chainKey} className={`object-contain ${className}`} />;
  }
  
  switch (chainKey) {
    case 'sol':
      return (
        <svg width={s} height={s} viewBox="0 0 32 32" fill="none" className={className}>
          <circle cx="16" cy="16" r="16" fill="#000" />
          <defs>
            <linearGradient id="sol-grad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#00FFA3" />
              <stop offset="100%" stopColor="#DC1FFF" />
            </linearGradient>
          </defs>
          <path d="M9.5 20.5L13 17H24L20.5 20.5H9.5Z" fill="url(#sol-grad)" />
          <path d="M9.5 11.5L13 15H24L20.5 11.5H9.5Z" fill="url(#sol-grad)" />
          <path d="M24 16L20.5 12.5H9.5L13 16H24Z" fill="url(#sol-grad)" opacity="0.7" />
        </svg>
      );

    case 'arb':
      return (
        <svg width={s} height={s} viewBox="0 0 32 32" fill="none" className={className}>
          <circle cx="16" cy="16" r="16" fill="#2D374B" />
          <path d="M16.932 7L8.5 24.167H12.032L20.464 7H16.932Z" fill="#9CC0FF" />
          <path d="M15.068 7L23.5 24.167H19.968L11.536 7H15.068Z" fill="#28A0F0" />
        </svg>
      );

    case 'base':
      return (
        <svg width={s} height={s} viewBox="0 0 32 32" fill="none" className={className}>
          <circle cx="16" cy="16" r="16" fill="#0052FF" />
          <path d="M16 24C20.4183 24 24 20.4183 24 16C24 11.5817 20.4183 8 16 8C12.3065 8 9.19358 10.5005 8.26041 13.9016H16V18.0984H8.26041C9.19358 21.4995 12.3065 24 16 24Z" fill="white" />
        </svg>
      );

    case 'bsc':
      return (
        <svg width={s} height={s} viewBox="0 0 32 32" fill="none" className={className}>
          <circle cx="16" cy="16" r="16" fill="#F0B90B" />
          <path d="M16 7L13.5 9.5L16 12L18.5 9.5L16 7Z" fill="white" />
          <path d="M10.5 12.5L8 15L10.5 17.5L13 15L10.5 12.5Z" fill="white" />
          <path d="M21.5 12.5L19 15L21.5 17.5L24 15L21.5 12.5Z" fill="white" />
          <path d="M16 18L13.5 20.5L16 23L18.5 20.5L16 18Z" fill="white" />
          <path d="M16 13.5L13.5 16L16 18.5L18.5 16L16 13.5Z" fill="white" />
        </svg>
      );

    case 'rhc':
      return (
        <svg width={s} height={s} viewBox="0 0 32 32" fill="none" className={className}>
          <circle cx="16" cy="16" r="16" fill="#00C853" />
          <path d="M10 10H22V13H13V15H20V18H13V22H10V10Z" fill="white" />
          <path d="M17 18H22V22H17V18Z" fill="white" />
        </svg>
      );

    case 'arc':
      return (
        <svg width={s} height={s} viewBox="0 0 32 32" fill="none" className={className}>
          <circle cx="16" cy="16" r="16" fill="#FF6D00" />
          <path d="M16 8C11.582 8 8 11.582 8 16C8 20.418 11.582 24 16 24" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
          <path d="M16 12C13.791 12 12 13.791 12 16C12 18.209 13.791 20 16 20" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
          <circle cx="16" cy="16" r="1.5" fill="white" />
        </svg>
      );

    default:
      return (
        <svg width={s} height={s} viewBox="0 0 32 32" fill="none" className={className}>
          <circle cx="16" cy="16" r="16" fill="#374151" />
          <circle cx="16" cy="16" r="6" stroke="#9CA3AF" strokeWidth="2" />
        </svg>
      );
  }
});

ChainLogo.displayName = 'ChainLogo';

export default ChainLogo;
