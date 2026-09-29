// Read-only smoke test: node --import tsx scripts/verify-launchpads.mjs [source...]
import { LAUNCHPADS, fetchLaunchpadFeed } from '../src/services/launchpads.ts';
const selected = process.argv.slice(2);
const sources = selected.length ? selected : LAUNCHPADS.map((s) => s.id);
let failures = 0;
for (const source of sources) {
  try {
    const result = await fetchLaunchpadFeed(source);
    console.log(JSON.stringify({ source, pools: result.pools.length, partial: result.partial, observedAt: result.observedAt }));
    if (result.partial) failures++;
  } catch (error) {
    failures++;
    console.error(JSON.stringify({ source, error: error instanceof Error ? error.message : String(error) }));
  }
}
process.exitCode = failures ? 1 : 0;
