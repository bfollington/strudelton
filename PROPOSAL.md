# Spec — Strudel → Living MIDI Clip (Ableton Extension probe)

**Status:** throwaway probe. Build the smallest thing that answers one question, then stop.
**Audience:** coding agent with access to the Ableton Extensions SDK docs (Live 12.4.5 beta, via Centercode) and Node 24.16.0.

---

## 0. The question this exists to answer

Does *sequence-as-program* feel alive to play when wired to real sound? Everything here is in service of that. If a feature does not help answer it, do not build it.

**Explicit non-goals (v1):** no audio/sound design in the extension, no automation/modulation output, no autocomplete polish, no multi-track, no preset system, no settings UI beyond what's needed to run. Sound design happens in Ableton on the receiving track; this extension only writes notes.

---

## 1. Concept

The extension opens a webview with a CodeMirror editor holding a Strudel pattern. While the webview is open, a loop on each cycle boundary queries the *next* cycle of the pattern and writes those events into a single looping MIDI clip. The clip is a sliding one-cycle window onto an infinite deterministic pattern. Ableton's transport is the clock; Strudel's purity provides the evolution. No scheduler is written.

```
[CodeMirror editor] --source--> [transpiler+core in Node] --queryArc(n, n+1)--> [haps]
        ^                                                                          |
        | (user edits live)                                          map haps -> MIDI notes
        |                                                                          v
        +--------------------- next loop boundary <----- [write clip] <-- [SDK clip API]
```

---

## 2. Resolved facts (do not re-derive)

- Strudel runs headless in Node with `@strudel/core`, `@strudel/mini`, `@strudel/transpiler`. No browser, no audio needed because we emit MIDI, not sound.
- `transpiler` turns user source (mini-notation + JS) into evaluable Pattern code; `core` evaluates it to a `Pattern`.
- `pattern.queryArc(begin, end)` returns an array of haps. Each hap has:
  - `hap.whole.begin`, `hap.whole.end` — Fraction objects (cycles). Use `.valueOf()` for float or `.toFraction()` for display. Haps with no `whole` are fragments — skip them (only emit `hap.hasOnset()` haps).
  - `hap.value` — the event value (note name/number, or an object of controls like `{ note, velocity, gain, ... }` depending on pattern).
- `queryArc` is pure: querying cycle N+1 deterministically yields the natural evolution (`degrade`, `sometimesBy`, `rand`, etc. are seeded by cycle position). No state to advance.

---

## 3. DERISK FIRST — resolve against the real SDK docs before writing the loop

These are unknown because the detailed SDK docs are gated. Answer each with a minimal spike and write the finding inline in the code as a comment. **Do not guess method names — read the SDK.**

1. **Persistent write handle.** Can an extension whose webview stays open keep mutating the Set repeatedly without being re-invoked from the context menu? (Bird Game generating notes per wing-flap implies yes.) Confirm the exact lifecycle/API for "extension stays alive while window open" and how to hold a reference to the target clip across writes.
2. **Transport position.** Can the extension read the current song/transport position (cycle/beat/bar), even by polling rather than callback? The loop needs to know where the playhead is to write the *next* window ahead of the loop boundary. Find the read path; note its update granularity.
3. **Clip note write API.** Exact calls to (a) get/select the target MIDI clip, (b) clear its notes, (c) write a batch of notes with start (beats), duration (beats), pitch (0–127), velocity (1–127). Note whether writes are atomic per call or need a transaction/undo boundary, and whether mid-loop edits land on the next loop pass cleanly.
4. **Clip length / loop.** How to set the clip's loop length to exactly one cycle (or N cycles) in beats so the window math is trivial.

If (1) or (2) come back negative, stop and report — the living-window model depends on them. The fallback (manual re-trigger = pure offline bake) still works but is a different, less interesting probe.

---

## 4. Mapping: hap → MIDI note

Given the target track tempo and a chosen `cyclesPerClip` (default 1) and `beatsPerCycle` (default 4):

- `start_beats   = hap.whole.begin.valueOf() * beatsPerCycle` (relative to clip start; subtract the window's base cycle)
- `duration_beats = (hap.whole.end.valueOf() - hap.whole.begin.valueOf()) * beatsPerCycle`
- `pitch`: if `hap.value` is a number → use directly; if a string note name → convert (core exposes note-name parsing; otherwise a small map); if an object → read `value.note`.
- `velocity`: from `value.velocity` or `value.gain` scaled to 1–127; default 100.
- Skip haps where `!hap.hasOnset()`.

Keep mapping in one pure function `hapsToNotes(haps, baseCycle, cfg)` so it's testable without the SDK.

---

## 5. The re-bake loop

Reference: Strudel's own REPL scheduler (interval query + look-ahead with `minLatency`).

```
windowCycles = cyclesPerClip            // size of the clip window
let baseCycle = floor(currentTransportCycle / windowCycles) * windowCycles
loop, fired shortly BEFORE each loop boundary (look-ahead):
    nextBase = baseCycle + windowCycles
    haps  = pattern.queryArc(nextBase, nextBase + windowCycles)
    notes = hapsToNotes(haps, nextBase, cfg)
    writeClip(targetClip, notes)        // clear + write; lands on next loop pass
    baseCycle = nextBase
on user edit:
    re-transpile + re-evaluate pattern; next loop iteration uses the new pattern automatically (queryArc is pure)
```

Look-ahead amount: derive from polled transport position + a fixed safety margin (start ~1/8 cycle early; tune). If transport polling granularity is coarse, widen the margin. Accept that the swap is loop-quantized and not sample-accurate — that is fine for this probe.

---

## 6. Editor

CodeMirror in the webview. Load the pattern text, transpile on change (debounced ~150ms), show transpile errors inline (the transpiler returns error location). Strudel's existing editor/highlight extensions can be reused if they drop in cleanly; if not, plain CodeMirror is sufficient for v1. Do not build autocomplete in v1.

---

## 7. Milestones

- **M0 — headless spike (no Ableton).** Node script: transpile a hardcoded pattern, `queryArc(0,1)`, map to notes, print them. Proves the Strudel half end-to-end. ~½ day.
- **M1 — derisk SDK.** Resolve all four Section 3 questions with minimal spikes inside a real extension. Write findings as comments. Gate: (1) and (2) must pass.
- **M2 — static bake.** Extension writes one cycle of a hardcoded pattern into a selected MIDI clip on trigger. Plays in Ableton.
- **M3 — living window.** Add the editor + the re-bake loop. Edit the pattern while transport runs; clip evolves on each loop. **This is the probe.** Play with it; answer Section 0. Stop.

---

## 8. Risks / known ceilings

- Loop-quantized, non-sample-accurate swaps → "evolving," not "tight." Expected; tightness is the real-time-engine work this skips.
- GC/scheduling jitter in Node may occasionally drop a write near the boundary. Acceptable for a probe; widen look-ahead if frequent.
- Note-name → pitch conversion edge cases (scales, octave offsets). Keep patterns numeric-ish in early tests to sidestep.
- AGPL: this links Strudel's copyleft core. If released, release the whole extension AGPL-3.0. Fine for a community build; keep the code path clean so the eventual non-Strudel DSL project shares nothing copyleft.

---

## 9. What to carry into the real project

Whether the living-window *feel* is compelling, what about the pattern language is expressive vs. frustrating against real sound, and how the edit→hear latency reads. Those findings inform the Digitakt-DSL authoring layer. The re-bake engine itself is disposable — the real project needs a true real-time scheduler, which this deliberately does not build.
