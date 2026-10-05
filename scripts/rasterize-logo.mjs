// Render the PNG favicons, touch icon and bot avatar from public/brand/*.svg
// with a local headless Chrome/Edge (no extra dependencies).
//
//   node scripts/rasterize-logo.mjs            # auto-detects the browser
//   CHROME=/path/to/chrome node scripts/rasterize-logo.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const pub = join(root, 'public');

const candidates = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const browser = candidates.find((path) => existsSync(path));
if (!browser) throw new Error('No Chrome/Edge found; set CHROME=/path/to/browser');

/** [svg in public/, png out in public/, width, height] */
const jobs = [
  ['brand/logo-icon.svg', 'brand/logo-icon.png', 256, 256],
  ['brand/logo-icon.svg', 'favicon-512.png', 512, 512],
  ['brand/favicon.svg', 'favicon-32.png', 32, 32],
  ['brand/favicon.svg', 'favicon-16.png', 16, 16],
  ['brand/bot-avatar.svg', 'brand/bot-avatar.png', 640, 640],
  ['brand/bot-avatar.svg', 'apple-touch-icon.png', 180, 180],
  ['brand/logo-full.svg', 'brand/logo-full.png', 1200, 485],
];

const work = mkdtempSync(join(tmpdir(), 'hopr-logo-'));
try {
  for (const [svg, png, width, height] of jobs) {
    const page = join(work, 'page.html');
    writeFileSync(page, `<!doctype html><html><head><style>html,body{margin:0;background:transparent;overflow:hidden}img{display:block;width:${width}px;height:${height}px}</style></head><body><img src="${pathToFileURL(join(pub, svg))}"></body></html>`);
    execFileSync(browser, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
      `--user-data-dir=${join(work, 'profile')}`,
      '--default-background-color=00000000', '--blink-settings=preferredColorScheme=0', // PNGs use the dark tile
       `--window-size=${width},${height}`,
      `--screenshot=${join(pub, png)}`, pathToFileURL(page).href,
    ], { stdio: 'ignore' });
    console.log(`${png}  ${width}×${height}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
