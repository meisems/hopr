/** Deterministic, hand-written optical illustration; no stock or generated image assets. */
let cached: HTMLCanvasElement | undefined;
const fract = (n: number) => n - Math.floor(n);
function noise(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const hash = (a: number, b: number) => fract(Math.sin(a * 127.1 + b * 311.7) * 43758.5453);
  const a = hash(ix, iy), b = hash(ix + 1, iy), d = hash(ix, iy + 1), e = hash(ix + 1, iy + 1);
  return (a + (b - a) * u) * (1 - v) + (d + (e - d) * u) * v;
}
function turbulence(x: number, y: number): number {
  return noise(x, y) * .55 + noise(x * 2.03 + 9, y * 2.03) * .28 + noise(x * 4.1, y * 4.1 + 13) * .17;
}
const gaussian = (x: number, width: number) => Math.exp(-(x * x) / (width * width));

export function drawPnlSpace(): HTMLCanvasElement {
  if (cached) return cached;
  const canvas = document.createElement('canvas'); canvas.width = 1440; canvas.height = 900;
  const c = canvas.getContext('2d')!;
  const image = c.createImageData(1440, 900);
  // Thin disk viewed almost edge-on, with a separate bent image of its far side.
  // This is an optical illustration, not a numerical relativity simulation.
  const rotation = -.16, co = Math.cos(rotation), si = Math.sin(rotation);
  for (let y = 0; y < 900; y++) for (let x = 0; x < 1440; x++) {
    const dx = x - 1100, dy = y - 375;
    const u = dx * co + dy * si, v = -dx * si + dy * co;
    const r = Math.hypot(u, v), diskR = Math.hypot(u, v / .19);
    const angle = Math.atan2(v / .19, u);
    const fog = gaussian(r - 220, 290) * .065;
    let red = 3 + fog * 67, green = 7 + fog * 84, blue = 12 + fog * 108;
    const ring = gaussian(r - 142, 1.5) * .75 + gaussian(r - 146, 10) * .13;
    const far = gaussian(Math.hypot(u, v / 1.04) - 172, 19) * (v < 0 ? 1 : .22);
    const farTexture = far > .006 ? .55 + turbulence(u / 26, v / 17) * .65 : 0;
    const bend = far * farTexture * 1.1;
    let disk = 0;
    if (diskR > 157 && diskR < 610 && (r > 143 || v > 0)) {
      const t = turbulence(diskR / 35, angle * 11);
      const filaments = .82 + .18 * Math.sin(diskR * .36 + t * 14 + angle * 10);
      const inner = Math.min(1, (diskR - 157) / 22);
      const outer = Math.max(0, 1 - (diskR - 157) / 453);
      const beaming = 1.12 - u / 800;
      disk = inner * Math.pow(outer, 1.8) * (.38 + t * .8) * filaments * beaming * 2.2;
    }
    const bloom = gaussian(v, 31) * gaussian(u, 430) * .24 + gaussian(r - 170, 52) * .16;
    if (r < 140) { red = 1; green = 3; blue = 6; }
    const light = disk + bend + ring + (r > 143 ? bloom : 0);
    // Warm-white inner plasma, copper outer filaments and cool scattered ambient light.
    red += 255 * (1 - Math.exp(-light * 1.8));
    green += 240 * (1 - Math.exp(-light * 1.24));
    blue += 224 * (1 - Math.exp(-light * .86));
    const vignette = .55 + .45 * gaussian(Math.hypot((x - 850) / 1.8, y - 400), 750);
    const grain = (fract(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) - .5) * 2.5;
    const p = (y * 1440 + x) * 4;
    image.data[p] = red * vignette + grain;
    image.data[p + 1] = green * vignette + grain;
    image.data[p + 2] = blue * vignette + grain;
    image.data[p + 3] = 255;
  }
  c.putImageData(image, 0, 0);
  let seed = 21419;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 650; i++) {
    const x = random() * 1440, y = random() * 900;
    if (Math.hypot(x - 1100, y - 375) < 205) continue;
    const bright = random(), radius = bright > .992 ? 1.5 : .2 + random() * .65;
    c.fillStyle = `rgba(207,224,235,${.1 + bright * .55})`;
    c.beginPath(); c.arc(x, y, radius, 0, Math.PI * 2); c.fill();
    if (bright > .992) {
      const halo = c.createRadialGradient(x, y, 0, x, y, 12);
      halo.addColorStop(0, 'rgba(193,224,251,.35)'); halo.addColorStop(1, 'rgba(125,175,236,0)');
      c.fillStyle = halo; c.fillRect(x - 12, y - 12, 24, 24);
    }
  }
  cached = canvas;
  return canvas;
}
