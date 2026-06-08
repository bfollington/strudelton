// Proves the Strudel engine survives esbuild -> CJS bundling and runs in a plain Node
// runtime (the same model as the Extension Host). No Ableton needed: `npm run smoke`.
// If this prints notes, the risky "Strudel inside the extension" assumption holds.
import { evaluatePattern, bakeCycles } from "../../src/bake.mjs";

const DEFAULT_PATTERN = 'note("c3 e3 g3 b3 a3 g3 e3 d3").degradeBy(0.3)';
const CFG = { beatsPerCycle: 4, defaultVelocity: 100 };

// CJS output forbids top-level await, so wrap in an async IIFE.
void (async () => {
  const { pattern } = await evaluatePattern(DEFAULT_PATTERN);
  for (let cycle = 0; cycle < 3; cycle++) {
    const { notes } = bakeCycles(pattern, cycle, 1, CFG);
    console.log(`cycle ${cycle}: ${notes.length} notes -> [${notes.map((n) => n.pitch).join(" ")}]`);
  }
  console.log("SMOKE OK: Strudel bundled to CJS and ran inside Node (Extension Host runtime model).");
})();
