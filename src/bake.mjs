// src/bake.mjs — the Strudel → MIDI core. Pure & headless; NO Ableton SDK imports.
//
// This is the half of the probe that carries forward regardless of which Ableton
// architecture we land on (living-window vs. offline bake — see FINDINGS.md). It
// turns Strudel source text into SDK-shaped note batches and is fully testable in
// Node with no browser and no audio.
//
// DERISK RESULT (Strudel half): CONFIRMED working headless, with two caveats the
// proposal's "resolved facts" did not capture:
//   1. Must pin @strudel/{core,mini,transpiler} to 1.2.5. In 1.2.6 core grew a hard
//      dependency on @kabelsalat/web (an audio/synth pkg) whose 0.4.1 build fails to
//      resolve its `SalatRepl` named export under Node ESM. 1.2.5 is the last
//      audio-free, truly-headless core. (See FINDINGS.md §Strudel.)
//   2. Scales / `.scale()` / voicings live in @strudel/tonal, not core. Numeric and
//      note-name patterns work with core+mini alone; scale-degree patterns need tonal.

// IMPORTANT: run this in a NORMAL Node process only — the M0 spike, the smoke harness, and (in
// the extension) a child `node` process the extension spawns. Do NOT import it into the Ableton
// extension's own process: the Extension Host's bare/shared-scope V8 breaks Strudel's `evalScope`
// (mini's `h` clobbers core's `Fraction`, etc.). In a normal Node process none of that happens —
// this is just plain Strudel. See FINDINGS.md §"Why a child process".
import { evalScope, noteToMidi } from '@strudel/core';
import * as core from '@strudel/core';
import * as mini from '@strudel/mini';
import { evaluate } from '@strudel/transpiler';

// evalScope must run once before evaluate() so transpiled source can see the Strudel
// globals (note, sequence, mini, s, ...). Idempotent guard so callers can be careless.
let _scopeReady = null;
export function loadStrudel() {
  if (!_scopeReady) {
    // To add scales later: also pass `import * as tonal from '@strudel/tonal'`.
    _scopeReady = evalScope(core, mini);
  }
  return _scopeReady;
}

/**
 * Transpile + evaluate Strudel source into a Pattern.
 * @param {string} code - Strudel source (mini-notation + JS), e.g. `note("c3 e3 g3 b3")`.
 * @returns {Promise<{pattern: object, meta: object}>}
 */
export async function evaluatePattern(code) {
  await loadStrudel();
  const { pattern, meta } = await evaluate(code); // evaluate() => { mode, pattern, meta }
  return { pattern, meta };
}

// --- hap.value → MIDI pitch ------------------------------------------------------
// Observed value shapes from queryArc (see spikes/explore-haps.mjs):
//   bare number    : 0            (note("48 52") or mini "48 52" -> direct MIDI number)
//   note name      : "c3"         (rare as bare; usually wrapped in an object)
//   controls object: { note: "c3", velocity: 0.9, gain: 0.5, ... }
//   drum/sound only: { s: "bd" }  (no pitch — unmappable without a drum-name table)
function valueToPitch(v) {
  if (typeof v === 'number') return Math.round(v);
  if (typeof v === 'string') return safeNoteToMidi(v);
  if (v && typeof v === 'object') {
    if (typeof v.note === 'number') return Math.round(v.note);
    if (typeof v.note === 'string') return safeNoteToMidi(v.note);
    if (typeof v.n === 'number') return Math.round(v.n); // `n` control fallback
  }
  return null; // unmappable (e.g. pure {s:"bd"}) — caller skips it
}

function safeNoteToMidi(name) {
  try {
    const m = noteToMidi(name);
    return Number.isFinite(m) ? Math.round(m) : null;
  } catch {
    return null;
  }
}

// --- hap.value → Live velocity (1–127) -------------------------------------------
// Strudel velocity/gain are 0–1. Proposal default is 100 when neither is present.
function valueToVelocity(v, defaultVel = 100) {
  let g = null;
  if (v && typeof v === 'object') {
    if (typeof v.velocity === 'number') g = v.velocity;
    else if (typeof v.gain === 'number') g = v.gain;
  }
  if (g === null) return defaultVel;
  return clampInt(Math.round(g * 127), 1, 127);
}

const clampInt = (n, lo, hi) => Math.max(lo, Math.min(hi, n | 0));

/**
 * Pure mapping: haps → SDK NoteDescription[]. The single function the whole probe
 * pivots on; testable without Ableton.
 *
 * Output matches the Extensions SDK `NoteDescription` type exactly:
 *   { pitch, startTime, duration, velocity, muted? }  (times in BEATS, relative to clip start)
 *
 * @param {Array} haps  - result of pattern.queryArc(baseCycle, baseCycle + cyclesPerClip)
 * @param {number} baseCycle - the window's base cycle (subtracted so clip starts at beat 0)
 * @param {object} cfg
 * @param {number} [cfg.beatsPerCycle=4]
 * @param {number} [cfg.defaultVelocity=100]
 * @returns {{notes: Array, skipped: number}} notes + count of haps that couldn't map to a pitch
 */
export function hapsToNotes(haps, baseCycle, cfg = {}) {
  const beatsPerCycle = cfg.beatsPerCycle ?? 4;
  const defaultVelocity = cfg.defaultVelocity ?? 100;
  const notes = [];
  let skipped = 0;

  for (const hap of haps) {
    if (!hap.hasOnset || !hap.hasOnset()) continue; // skip fragments (no `whole`)
    const begin = hap.whole.begin.valueOf();
    const end = hap.whole.end.valueOf();
    const pitch = valueToPitch(hap.value);
    if (pitch === null || pitch < 0 || pitch > 127) {
      skipped++;
      continue;
    }
    notes.push({
      pitch,
      startTime: (begin - baseCycle) * beatsPerCycle,
      duration: (end - begin) * beatsPerCycle,
      velocity: valueToVelocity(hap.value, defaultVelocity),
    });
  }
  return { notes, skipped };
}

/**
 * Bake `count` cycles of a pattern starting at `baseCycle` into one note batch,
 * positioned in a clip that is `count * beatsPerCycle` beats long. This is the
 * "offline bake" primitive (one long looping clip captures N cycles of evolution).
 */
export function bakeCycles(pattern, baseCycle, count, cfg = {}) {
  const haps = pattern.queryArc(baseCycle, baseCycle + count);
  return hapsToNotes(haps, baseCycle, cfg);
}
