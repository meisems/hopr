import { drawPnlSpace } from './pnlArtwork';
export interface PnlCardData {
  symbol: string; chain: string; pnlUsd: number; pnlPercent: number;
  investedUsd: number; valueUsd: number; realizedUsd: number; observedAt: number;
}
const money = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(n);
export function validPnlCard(data: PnlCardData): boolean {
  return [data.pnlUsd, data.pnlPercent, data.investedUsd, data.valueUsd, data.realizedUsd, data.observedAt].every(Number.isFinite)
    && data.investedUsd > 0 && data.valueUsd >= 0 && data.realizedUsd >= 0;
}

/** 2x export keeps the logo and typography crisp when shared or cropped. */
export async function renderPnlCard(canvas: HTMLCanvasElement, data: PnlCardData): Promise<Blob> {
  if (!validPnlCard(data)) throw new Error('A complete position valuation is needed to create a PnL card.');
  canvas.width = 2880; canvas.height = 1800;
  const c = canvas.getContext('2d');
  if (!c) throw new Error('Image export is not supported by this browser.');
  const logo = new Image(); logo.src = '/brand/logo-mark.svg';
  await logo.decode();
  c.scale(2, 2);
  c.drawImage(drawPnlSpace(), 0, 0, 1440, 900);
  const scrim = c.createLinearGradient(0, 0, 1050, 0);
  scrim.addColorStop(0, 'rgba(3,8,14,.92)'); scrim.addColorStop(.58, 'rgba(3,8,14,.8)'); scrim.addColorStop(1, 'rgba(3,8,14,0)');
  c.fillStyle = scrim; c.fillRect(0, 0, 1440, 900);
  const bottom = c.createLinearGradient(0, 575, 0, 900);
  bottom.addColorStop(0, 'rgba(3,8,14,0)'); bottom.addColorStop(1, '#03080e');
  c.fillStyle = bottom; c.fillRect(0, 575, 1440, 325);
  const sans = '"Inter", "Segoe UI", sans-serif';
  const mono = '"JetBrains Mono", "Consolas", monospace';
  const label = (text: string, x: number, y: number, color = '#78949e') => {
    c.font = '500 15px ' + mono; c.fillStyle = color;
    let cursor = x;
    for (const ch of text) { c.fillText(ch, cursor, y); cursor += c.measureText(ch).width + 1.7; }
  };
  const fit = (text: string, x: number, y: number, size: number, width: number, weight = 600) => {
    c.font = weight + ' ' + size + 'px ' + sans;
    while (c.measureText(text).width > width && size > 16) { size--; c.font = weight + ' ' + size + 'px ' + sans; }
    c.fillText(text, x, y);
  };
  c.save(); c.filter = 'brightness(2.2)'; c.drawImage(logo, 65, 51, 83, 55); c.restore();
  c.fillStyle = '#f2f9f8'; c.font = '650 44px ' + sans; c.fillText('hopr', 164, 96);
  c.fillStyle = '#29434b'; c.fillRect(302, 63, 1, 39);
  label('HOP ACROSS CHAINS', 325, 87, '#a3b7bd');
  label('PNL / SNAPSHOT', 1190, 85, '#a3b7bd');
  c.strokeStyle = 'rgba(173,209,213,.13)'; c.lineWidth = 1; c.beginPath(); c.moveTo(76, 136); c.lineTo(1364, 136); c.stroke();
  label('POSITION PERFORMANCE', 78, 216);
  c.fillStyle = '#eef7f6'; fit(data.symbol.slice(0, 28), 74, 286, 55, 735, 600);
  const chain = data.chain.toUpperCase(); c.font = '500 14px ' + mono;
  const badgeWidth = Math.min(340, c.measureText(chain).width + 52);
  c.fillStyle = 'rgba(61,110,119,.16)'; c.beginPath(); c.roundRect(78, 307, badgeWidth, 33, 16); c.fill();
  c.fillStyle = '#80d4ca'; c.beginPath(); c.arc(94, 324, 3, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#c1d9dc'; c.fillText(chain, 108, 329, 290);
  const positive = data.pnlUsd >= 0;
  const percent = (positive ? '+' : '') + data.pnlPercent.toFixed(2) + '%';
  c.fillStyle = positive ? '#b6fce2' : '#ffadb9';
  c.save(); c.shadowBlur = 28; c.shadowColor = positive ? 'rgba(99,236,192,.14)' : 'rgba(255,127,146,.14)';
  fit(percent, 66, 489, 134, 845, 650); c.restore();
  c.fillStyle = positive ? '#76cdb1' : '#d68597';
  fit((positive ? '+' : '−') + money(Math.abs(data.pnlUsd)), 78, 551, 37, 735, 500);
  label('ESTIMATED TOTAL PNL', 80, 591);
  // A restrained smoked-glass ledger keeps the accounting separate from the hero.
  const glass = c.createLinearGradient(0, 651, 0, 790);
  glass.addColorStop(0, 'rgba(24,42,51,.68)'); glass.addColorStop(1, 'rgba(11,23,33,.48)');
  c.fillStyle = glass; c.beginPath(); c.roundRect(76, 651, 1288, 139, 18); c.fill();
  c.strokeStyle = 'rgba(141,183,191,.19)'; c.stroke();
  const metrics = [['RECORDED COST', data.investedUsd], ['CURRENT VALUE', data.valueUsd], ['SALE PROCEEDS', data.realizedUsd]] as const;
  metrics.forEach(([title, value], i) => {
    const x = 108 + i * 429;
    if (i) { c.fillStyle = 'rgba(124,165,175,.16)'; c.fillRect(x - 32, 682, 1, 74); }
    label(title, x, 693);
    c.fillStyle = '#e5f0f2'; fit(money(value), x, 747, 34, 360, 500);
  });
  c.fillStyle = '#859aa4'; c.font = '14px ' + sans;
  c.fillText('Estimated from recorded HOPR trades · Untracked transfers and gas excluded', 78, 833);
  c.fillStyle = '#526e7b'; c.font = '13px ' + mono;
  c.fillText(new Date(data.observedAt).toISOString().replace('T', ' ').slice(0, 19) + ' UTC', 78, 861);
  label('HOPR TERMINAL', 1170, 848, '#83aaa9');
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Image export failed.')), 'image/png'));
}
