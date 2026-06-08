import { evalScope } from '@strudel/core';
import * as core from '@strudel/core';
import * as mini from '@strudel/mini';
import { evaluate } from '@strudel/transpiler';
await evalScope(core, mini);

console.log('noteToMidi exists?', typeof core.noteToMidi, '| example c3 ->', core.noteToMidi?.('c3'), '| a4 ->', core.noteToMidi?.('a4'));

async function probe(label, code, arcA=0, arcB=1) {
  try {
    const { pattern } = await evaluate(code);
    const haps = pattern.queryArc(arcA, arcB);
    console.log(`\n=== ${label} :: ${code}  [${arcA},${arcB})  (${haps.length} haps)`);
    for (const h of haps) {
      console.log('  value=', JSON.stringify(h.value),
        '| whole=', h.whole ? `${h.whole.begin.valueOf()}..${h.whole.end.valueOf()}` : 'NONE(fragment)',
        '| onset=', h.hasOnset());
    }
  } catch (e) {
    console.log(`\n=== ${label} :: ${code}  -> ERROR: ${e.message.split('\n')[0]}`);
  }
}

await probe('controls: velocity', 'note("c3 e3").velocity("0.4 0.9")');
await probe('controls: gain', 'note("c3 e3").gain("0.5 1")');
await probe('subdiv + rest', 'note("c3 [e3 g3] ~ b3")');
await probe('sound/s pattern (drums)', 's("bd sd bd sd")');
console.log('\n--- EVOLUTION: same pattern across 3 cycles (determinism) ---');
await probe('degradeBy cycle0', 'note("c3 e3 g3 b3").degradeBy(0.5)', 0, 1);
await probe('degradeBy cycle1', 'note("c3 e3 g3 b3").degradeBy(0.5)', 1, 2);
await probe('degradeBy cycle2', 'note("c3 e3 g3 b3").degradeBy(0.5)', 2, 3);
