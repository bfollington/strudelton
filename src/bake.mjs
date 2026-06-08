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
import * as tonal from '@strudel/tonal';
import { evaluate } from '@strudel/transpiler';

// evalScope must run once before evaluate() so transpiled source can see the Strudel
// globals (note, sequence, mini, s, ...). Idempotent guard so callers can be careless.
let _scopeReady = null;
export function loadStrudel() {
  if (!_scopeReady) {
    // Custom control: `.prob(p)` / `.chance(p)` (0–1) attaches a per-note probability we map to
    // Live's NoteDescription.probability. Live re-rolls it every loop, so a baked clip evolves
    // while looping with no re-bake — the closest we get to "alive" without a transport read.
    // (Unlike `degradeBy`, which drops haps deterministically at bake time.) registerControl
    // patches Pattern.prototype.{prob,chance} and returns the standalone control fns.
    const probControls = core.registerControl('prob', 'chance');
    // @strudel/tonal adds scale/key snapping, chords, and voicings (`.scale("C:minor")`,
    // `n("0 2 4").scale(...)`, `.voicing()`, etc.). It emits note-name values that map cleanly
    // to MIDI via noteToMidi.
    _scopeReady = evalScope(core, mini, tonal, probControls);
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

// Strudel/Tidal drum-abbreviation → MIDI note, GM-aligned. Matches Ableton's default Drum Rack,
// whose first pad is C1 = MIDI 36. Used when a hap has a sound (`s`) but no pitch — so
// `s("bd sd hh")` targets a Drum Rack. Override/extend per bake via cfg.drumMap.
export const DEFAULT_DRUM_MAP = {
  bd: 36, kick: 36, bass: 36,
  sd: 38, snare: 38, sn: 38,
  rim: 37, rs: 37, sidestick: 37, st: 37,
  cp: 39, clap: 39, hc: 39,
  hh: 42, ch: 42, hat: 42, chh: 42, closedhat: 42,
  oh: 46, ohh: 46, openhat: 46,
  ph: 44, pedalhat: 44,
  lt: 45, lowtom: 45,
  mt: 47, midtom: 47,
  ht: 50, hitom: 50, hightom: 50,
  cr: 49, crash: 49,
  rd: 51, ride: 51,
  cb: 56, cowbell: 56,
  tb: 54, tamb: 54, tambourine: 54,
  sh: 70, shaker: 70, maracas: 70,
  cl: 75, claves: 75,
  perc: 39,
};

function drumNameToPitch(s, drumMap) {
  const name = String(s).split(':')[0].trim().toLowerCase(); // s("bd:2") sample variant -> "bd"
  return Object.prototype.hasOwnProperty.call(drumMap, name) ? drumMap[name] : null;
}

// --- hap.value → MIDI pitch ------------------------------------------------------
// Observed value shapes from queryArc (see spikes/explore-haps.mjs):
//   bare number    : 0            (note("48 52") or mini "48 52" -> direct MIDI number)
//   note name      : "c3"         (rare as bare; usually wrapped in an object)
//   controls object: { note: "c3", velocity: 0.9, gain: 0.5, ... }
//   drum/sound only: { s: "bd" }  -> drum-name table (else skipped)
function valueToPitch(v, drumMap) {
  if (typeof v === 'number') return Math.round(v);
  if (typeof v === 'string') return safeNoteToMidi(v);
  if (v && typeof v === 'object') {
    if (typeof v.note === 'number') return Math.round(v.note);
    if (typeof v.note === 'string') return safeNoteToMidi(v.note);
    if (typeof v.s === 'string') {
      const p = drumNameToPitch(v.s, drumMap); // drum sound -> pad
      if (p !== null) return p;
    }
    if (typeof v.n === 'number') return Math.round(v.n); // `n` control fallback
  }
  return null; // unmappable (e.g. a non-drum sample with no note) — caller skips it
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

// --- hap.value → Live per-note probability (0–1) ---------------------------------
// From the `.prob()`/`.chance()` control registered in loadStrudel. Returns null when absent
// so the caller can leave probability at Live's default (1 = always plays).
function valueToProbability(v) {
  if (v && typeof v === 'object' && typeof v.prob === 'number') {
    return Math.max(0, Math.min(1, v.prob));
  }
  return null;
}

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
 * @param {Object<string,number>} [cfg.drumMap] - extra/override drum-name→MIDI entries.
 * @returns {{notes: Array, skipped: number}} notes + count of haps that couldn't map to a pitch
 */
export function hapsToNotes(haps, baseCycle, cfg = {}) {
  const beatsPerCycle = cfg.beatsPerCycle ?? 4;
  const defaultVelocity = cfg.defaultVelocity ?? 100;
  const drumMap = cfg.drumMap ? { ...DEFAULT_DRUM_MAP, ...cfg.drumMap } : DEFAULT_DRUM_MAP;
  const notes = [];
  let skipped = 0;

  for (const hap of haps) {
    if (!hap.hasOnset || !hap.hasOnset()) continue; // skip fragments (no `whole`)
    const begin = hap.whole.begin.valueOf();
    const end = hap.whole.end.valueOf();
    const pitch = valueToPitch(hap.value, drumMap);
    if (pitch === null || pitch < 0 || pitch > 127) {
      skipped++;
      continue;
    }
    const note = {
      pitch,
      startTime: (begin - baseCycle) * beatsPerCycle,
      duration: (end - begin) * beatsPerCycle,
      velocity: valueToVelocity(hap.value, defaultVelocity),
    };
    // Only set probability when explicitly < 1, so default-probability notes stay clean.
    const prob = valueToProbability(hap.value);
    if (prob !== null && prob < 1) note.probability = prob;
    notes.push(note);
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
