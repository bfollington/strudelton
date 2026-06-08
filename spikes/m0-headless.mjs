// spikes/m0-headless.mjs — Milestone M0: prove the Strudel half end-to-end, no Ableton.
//
//   transpile hardcoded pattern -> queryArc -> hapsToNotes -> print SDK NoteDescription[]
//
// Run:  node spikes/m0-headless.mjs    (needs Node >=22; we pin 24.16.0 via mise.toml)

import { evaluatePattern, hapsToNotes, bakeCycles } from '../src/bake.mjs';

const CFG = { beatsPerCycle: 4, defaultVelocity: 100 };

function printNotes(notes) {
  if (!notes.length) return console.log('   (no notes)');
  console.log('   pitch  start  dur    vel');
  for (const n of notes) {
    console.log(
      '   ' +
        String(n.pitch).padEnd(6) +
        n.startTime.toFixed(3).padEnd(7) +
        n.duration.toFixed(3).padEnd(7) +
        String(n.velocity),
    );
  }
}

console.log('M0 — Strudel → MIDI, headless\n' + '='.repeat(50));

// 1) Static pattern, one cycle -> notes (the proposal's literal M0).
{
  const code = 'note("c3 e3 g3 b3").velocity("0.6 0.8 0.7 1.0")';
  const { pattern } = await evaluatePattern(code);
  const { notes, skipped } = hapsToNotes(pattern.queryArc(0, 1), 0, CFG);
  console.log(`\n[1] static, cycle 0:  ${code}`);
  printNotes(notes);
  if (skipped) console.log(`   (skipped ${skipped} unmappable)`);
}

// 2) The "living window": what each loop pass WOULD write. Same pattern, successive
//    cycles, queried purely — deterministic evolution with zero state advanced.
{
  const code = 'note("c3 e3 g3 a3 b3").degradeBy(0.4).sometimesBy(0.3, add(note(12)))';
  const { pattern } = await evaluatePattern(code);
  console.log(`\n[2] living window across 4 cycles:  ${code}`);
  for (let cycle = 0; cycle < 4; cycle++) {
    const { notes } = bakeCycles(pattern, cycle, 1, CFG); // window = 1 cycle at `cycle`
    console.log(`\n   --- cycle ${cycle} -> ${notes.length} notes (clip-relative beats) ---`);
    printNotes(notes);
  }
}

// 3) Offline-bake fallback: N cycles through-composed into ONE long looping clip.
//    Fully supported by the SDK today (clipSlot.createMidiClip(length) + clip.notes).
{
  const code = 'note("c3 e3 g3 b3").degradeBy(0.3)';
  const N = 4;
  const { pattern } = await evaluatePattern(code);
  const { notes } = bakeCycles(pattern, 0, N, CFG);
  console.log(`\n[3] through-composed ${N}-cycle bake (clip length ${N * CFG.beatsPerCycle} beats):  ${code}`);
  console.log(`   ${notes.length} notes spanning beats 0..${N * CFG.beatsPerCycle}`);
  printNotes(notes);
}

console.log('\n' + '='.repeat(50) + '\nM0 OK — Strudel half proven headless.');
