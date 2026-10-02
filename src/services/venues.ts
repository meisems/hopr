// Where a token trades, by the venue ids DexScreener (`flapsh`, `uniswap`) and
// GeckoTerminal (`four-meme`, `uniswap-v3-base`) report. Shared by the dashboard
// scanner and the worker so both name a market the same way.

/** Launchpads: a token trading here launched there. Checked in order; the first match wins. */
const LAUNCHPAD_VENUES: Array<[RegExp, string]> = [
  [/^pumpswap$/, 'PumpSwap'],
  [/^pumpfun$/, 'Pump.fun'],
  [/^nearpaid$/, 'NEARPaid'],
  [/^raydiumlaunchlab$/, 'LaunchLab'],
  [/^moonit$/, 'Moonit'],
  [/^letsbonkfun$/, 'LetsBonk'],
  [/^virtuals/, 'Virtuals'],
  [/^flap/, 'Flap'],
  [/^fourmeme$/, 'Four.meme'],
  [/^clanker/, 'Clanker'],
  [/^bankr/, 'Bankr'],
  [/^zora/, 'Zora'],
  [/^bags(fm)?$/, 'Bags'],
  [/^meteoradbc$/, 'Meteora DBC'],
  [/^heaven$/, 'Heaven'],
  [/^moonshot$/, 'Moonshot'],
  [/^boopfun$/, 'Boop'],
  [/^believe/, 'Believe'],
  [/stonk/, 'StonkFun'],
  [/argus/, 'ArgusWorld'],
  [/tolly/, 'TollyLabs'],
  [/pons/, 'PonsFamily'],
];

/** DEX families, for a readable "where it trades" label (versions kept: Uniswap v4, PancakeSwap v3). */
const DEX_VENUES: Array<[RegExp, string]> = [
  [/^uniswap/, 'Uniswap'],
  [/^pancakeswap/, 'PancakeSwap'],
  [/^aerodrome/, 'Aerodrome'],
  [/^sushiswap/, 'SushiSwap'],
  [/^camelot/, 'Camelot'],
  [/^ramses/, 'Ramses'],
  [/^raydium/, 'Raydium'],
  [/^orca/, 'Orca'],
  [/^meteora/, 'Meteora'],
  [/^(rhea|ref)/, 'Rhea'],
  [/^thena/, 'Thena'],
  [/^curve/, 'Curve'],
];

const normalize = (venue: string) => venue.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The launchpad a venue id belongs to, if any. A plain DEX (Uniswap, PancakeSwap…) is not a launchpad. */
export function launchpadFromVenue(venue: string | undefined): string | undefined {
  if (!venue) return undefined;
  const key = normalize(venue);
  return LAUNCHPAD_VENUES.find(([pattern]) => pattern.test(key))?.[1];
}

/** Human label for any venue id: "Flap", "Uniswap v3", "PancakeSwap Infinity", or a tidied id. */
export function venueName(venue: string | undefined): string {
  if (!venue) return 'DEX';
  const launchpad = launchpadFromVenue(venue);
  if (launchpad) return launchpad;
  const key = normalize(venue);
  const family = DEX_VENUES.find(([pattern]) => pattern.test(key))?.[1];
  if (!family) return venue.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  const version = venue.toLowerCase().match(/(?:^|[-_ ])(v\d|infinity|slipstream|dlmm|clmm)(?:[-_ ]|$)/)?.[1];
  if (!version) return family;
  const label = /^v\d$/.test(version) ? version : version.length === 4 ? version.toUpperCase() : version[0].toUpperCase() + version.slice(1);
  return `${family} ${label}`;
}

/**
 * Race market sources in priority order. Each task starts after its delay, or
 * as soon as every earlier task came back empty; the first non-null result
 * wins. A slow primary source costs at most its delay before the backup runs.
 */
export function firstHit<T>(tasks: Array<{ run: () => Promise<T | null | undefined>; delayMs: number }>): Promise<T | null> {
  return new Promise((resolve) => {
    let done = false;
    let finished = 0;
    const started = new Set<number>();
    const timers: ReturnType<typeof setTimeout>[] = [];
    const settle = (value: T | null) => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      resolve(value);
    };
    const start = (index: number) => {
      if (done || index >= tasks.length || started.has(index)) return;
      started.add(index);
      tasks[index].run().then((value) => {
        if (value !== null && value !== undefined) settle(value);
      }, () => undefined).finally(() => {
        finished += 1;
        if (finished === tasks.length) settle(null);
        // Everything started so far came back empty: don't wait for the next delay.
        else if (finished === started.size) start(Math.max(...started) + 1);
      });
    };
    if (!tasks.length) { resolve(null); return; }
    start(0);
    tasks.forEach((task, index) => {
      if (index > 0) timers.push(setTimeout(() => start(index), task.delayMs));
    });
  });
}
