# FINDINGS — Strudel → Ableton probe (de-risk pass, no Live yet)

Date: 2026-06-08. Toolchain: Node 24.16.0 (via `mise.toml`), Ableton Extensions SDK
`1.0.0-beta.0` (vendored in `vendor/sdk/`), Strudel `1.2.5` (pinned — see §Strudel).

**Bottom line:** Both halves work in pure Node. But the **living-window model (M3) as
specified is NOT buildable on Extensions SDK 1.0.0-beta.0** — there is no transport/
playhead read and no persistent webview. The proposal's own gate (§3: "if (1) or (2) come
back negative, stop and report") trips. The **offline-bake** path is fully supported and
is the recommended pivot.

---

## Milestone status

| Milestone | Status | Notes |
|---|---|---|
| M0 headless spike | ✅ done | `spikes/m0-headless.mjs` transpiles → queryArc → notes; evolution shown |
| M1 derisk SDK | ✅ done | four questions answered below; TS extension builds against SDK `.tgz` |
| M2 bake extension | ✅ **WORKING IN LIVE** | right-click a Session clip slot → "Strudel: Create & bake" writes the pattern's notes into a real MIDI clip; "Bake next window" steps the evolution |
| M3 living window | ❌ blocked | no transport, no persistent webview — pivoted to bake (chosen direction) |

**Chosen direction:** offline bake (option 1), confirmed working in Live 12.4.5b3. The extension is
a thin client that spawns a **child `node` process** to run Strudel (see §"Why a child process").

---

## §3 DERISK answers (against the real SDK)

Source of truth: `vendor/sdk-pkg/package/dist/index.d.mts` (974 lines, the full 1.0.0 API)
and `vendor/sdk/docs/**` (prose). Verified by reading + grepping the whole tree.

### Q1 — Persistent write handle / "extension stays alive". **PARTIAL.**
- **Process & handles: YES.** `export function activate(activation)` runs **once** at load;
  the Extension Host is a persistent Node process (`docs/development/2-execution.html`).
  State set in `activate` or in command callbacks survives. Objects are cached by handle id
  (`DataModelObjectRegistry`: "the same Live object always returns the same SDK instance"),
  so one `MidiClip` reference stays valid for repeated `clip.notes = …` writes. ✅
- **Persistent webview: NO.** The only webview API is `ui.showModalDialog(url, w, h):
  Promise<string>` — a **modal** dialog that loads a URL and returns **one** string via the
  `close_and_send` message, then closes (`docs/essentials/interface/2-…webviews.html`:
  "In the Extensions SDK, Webviews are displayed using Modal Dialogs"). No embedded/persistent
  panel; no channel to push updates into an open webview; the extension receives nothing until
  it closes. ⇒ "CodeMirror stays open while a background loop mutates the clip and reads live
  edits" is **not supported**.

### Q2 — Transport position. **NEGATIVE.** ← gating failure
The entire 1.0.0 surface exposes **no playhead / transport position, no is-playing, no
current-beat / song-time, and no transport events**. `Song` has `tempo`, `tracks`,
`returnTracks`, `scenes`, `cuePoints`, grid + scale getters — nothing time-varying about
playback. There are also **no observers/listeners/subscriptions anywhere**; the data model is
pull-only synchronous getters + async (callback/Promise) mutators. Grep across the type defs,
`.cjs/.mjs`, and source maps for `transport|playhead|playing|currentTime|songTime|observe|
listener|subscribe` → **0 hits**. ⇒ The re-bake loop has no clock to lock to and cannot be
notified of cycle/loop boundaries.

### Q3 — Clip note write API. **POSITIVE (clean).**
- Select target: context-menu scope `"MidiClip"` (or `"ClipSlot"`) passes a `Handle` to the
  command; resolve with `context.getObjectFromHandle(handle, MidiClip)`.
- Read: `midiClip.notes` → `NoteDescription[]`.
- Write (clear+write, atomic per call): `midiClip.notes = NoteDescription[]`
  (host bridge: `midiclipSetNotes` replaces ALL notes in one call).
- `NoteDescription = { pitch:0–127, startTime:beats, duration:beats, velocity?, muted?,
  probability?:0–1, velocityDeviation?, releaseVelocity?, selected? }`.
  (Note: Strudel's `degradeBy` probability could later map to Live's `probability` instead of
  dropping notes — nice future mapping.)
- Create: `clipSlot.createMidiClip(length)` (session) / `midiTrack.createMidiClip(startTime,
  duration)` (arrangement) → `Promise<MidiClip>`.
- Undo grouping: `context.withinTransaction(fn)` (sync callback; nested collapse). Individual
  mutations are already undoable.

**Expression ceiling — velocity YES, MPE NO.** `NoteDescription` (above) is the *entire* per-note
surface. `velocity` works (Strudel `.velocity()`/`.gain()` 0–1 → 1–127, verified). But there is
**no per-note pitch-bend, pressure/aftertouch, timbre/slide, note-expression envelope, CC, or
real-time MIDI out anywhere in the SDK** (grep for `pitchbend|aftertouch|pressure|mpe|note-
expression|timbre|cc|automation` → 0 hits). The SDK edits the Set's data model, it is not a MIDI
engine — so **MPE / continuous expression cannot be baked**, regardless of how expressively Strudel
describes it. Same class of ceiling as the missing transport: that's the real-time engine work this
probe skips. Upside: `probability` *is* writable per note and Live re-rolls it each loop —
**implemented**: a custom `.prob(p)`/`.chance(p)` control (registered in `bake.mjs`) attaches a
per-note probability (0–1) that maps to `NoteDescription.probability`, so a baked clip evolves while
it loops with no re-bake — the closest thing to "alive" without a transport read. (Distinct from
`degradeBy`, which drops haps deterministically at bake time.)

### Q4 — Clip length / loop. **POSITIVE (one constraint).**
- Set length at creation: `clipSlot.createMidiClip(beatsPerCycle)` → one-cycle clip. The
  created session clip's length is the loop. ✅
- `Clip.looping` is get/**set**; but `loopStart`/`loopEnd`/`startMarker`/`endMarker` are
  **get-only** — you cannot move loop markers after creation via the API. `ClipLoopSettings`
  exists only for **audio** clip creation, not MIDI.
- Constraint: to change loop length, recreate the clip (`deleteClip` + `createMidiClip(newLen)`)
  rather than mutate markers.

---

## What IS buildable (ranked) — the pivot menu

1. **Through-composed N-cycle bake → one long looping clip.** `createMidiClip(N*beatsPerCycle)`
   then `clip.notes = bakeCycles(pattern, 0, N)`. Captures N cycles of Strudel evolution as a
   seamless loop; **tight** (Live plays an ordinary clip). Simplest, 100% supported. Proven
   headless today (`m0-headless.mjs` part [3]).
2. **Modal editor → bake on close.** Context-menu "Edit Strudel…" on a clip opens
   `showModalDialog` with a CodeMirror editor (Strudel can even run *in* the webview to
   preview sound); on close, bake the pattern into the clip. Authoring loop is
   edit→close→hear (not live), but it's the closest thing to the proposal's editor within the
   modal constraint.
3. **Re-bake on manual re-trigger.** Context-menu "Bake next window" advances `baseCycle` by N
   and overwrites the clip each invocation — manually step through the evolution. Pure,
   deterministic, needs no clock. A user-driven stand-in for the "living" feel.
4. **(Degraded) free-running timer re-bake.** A `setInterval` in the Node process overwrites
   the clip every `60/bpm*beatsPerCycle` s. Evolves while playing but is **un-synced** to
   Live's loop (no playhead) → swaps land mid-cycle → glitches/drift. Worth one try to *feel*
   it, but likely reads as broken, not alive. Documents the ceiling.

---

## §Strudel — headless half

- **PIN `@strudel/{core,mini,transpiler}` to 1.2.5.** In **1.2.6**, `@strudel/core` grew a hard
  dependency on `@kabelsalat/web@^0.4.1` (an audio/synth pkg). The installed `0.4.1` build has
  no `exports` map and a CJS `main`, so Node's ESM loader resolves the CJS entry and fails to
  detect the `SalatRepl` named export → `SyntaxError: does not provide an export named
  'SalatRepl'` on import. **1.2.5 is the last audio-free, truly-headless core** (the proposal's
  "resolved fact" predates the regression).
- API: `evaluate(code)` → `{ pattern, meta }`; `pattern.queryArc(a,b)` → haps;
  `hap.hasOnset()`, `hap.whole.begin/end.valueOf()` (Fraction→float), `hap.value`.
- `hap.value` shapes: bare number (direct MIDI), `{ note:"c3"|number, velocity?, gain? }`,
  `{ s:"bd" }` (drum, no pitch — skip or map via a drum-name table). `core.noteToMidi('c3')=48`,
  standard A4=69 octave numbering.
- `.scale()` / voicings live in `@strudel/tonal`, not core. Numeric + note-name patterns work
  with core+mini alone (proposal already says keep early patterns numeric).
- **Evolution/determinism proven**: `degradeBy`/`sometimesBy` give different-but-deterministic
  haps per cycle, seeded by cycle position — querying cycle N+1 yields the natural evolution
  with zero state advanced.
- Benign import noise: `cannot use window: not in browser?` then `🌀 @strudel/core loaded 🌀`.

## Architecture — why a child process (the hard-won lesson)
**Do NOT run Strudel inside the Extension Host process.** We tried (bundle `@strudel/*` into the
extension and call it in-process) and burned a day on it. The Host runs the extension in a V8 that
is both **bare** (missing `performance` — `@strudel/core` calls `performance.now()` at load) and,
fatally, **shared-scope**: Strudel's `evalScope()` injects its entire function library into the
eval scope, and in the Host that scope is resolved in a way that makes those injected names collide
with the bundle's own bindings. Concretely:
- `@strudel/mini` exports `h` (its raw mini-reify, which feeds its argument to the peg parser).
  `@strudel/core`'s step/tactus code calls `h(<number>)` expecting `Fraction`. In the Host, core's
  call resolved to mini's `h` instead → the parser tried to `.substr` a number → crash. Strudel's
  `mini2ast` catch *masked* it (it assumed a peggy `SyntaxError` with `.location` and crashed on
  `.location.start` → the red-herring `reading 'start' of undefined`).
- Every targeted fix surfaced the next collision (e.g. pinning `h`→`Fraction` then hit a different
  binding → infinite recursion). It is unwinnable in-process.

None of this happens in a **normal Node process** (every command-line test passed throughout). So:

```
Extension Host (thin client, ~35 kb, NO Strudel)
  └─ spawn(process.execPath, ['dist/worker.cjs', base64(request)])   ← clean child `node`
        worker.cjs bundles @strudel/* and runs the bake normally
        → writes { ok, notes, skipped } JSON to stdout  (Strudel's console noise → stderr)
  ← extension parses stdout, writes notes to the clip via the SDK
```

`extension/src/worker.ts` is the worker; `bake.mjs` (plain Strudel) runs there. `extension.ts`'s
`bakeViaWorker()` spawns it. Latency is a few hundred ms per bake — fine for a manual bake.
Confirmed: the Host permits `child_process.spawn` + `process.execPath`, and the worker returns
correct notes that land in a real clip.

### Build toolchain
`tsc --noEmit && tsx build.ts` (esbuild) emits three CJS bundles: `dist/extension.js` (thin
client), `dist/worker.cjs` (Strudel engine), `dist/bundle-smoke.cjs` (`npm run smoke`, runs the
engine in plain Node without Live). `extensions-cli package` makes an installable
`strudelton-<ver>.ablx`. Only `extensions-cli run` (Developer Mode) needs Ableton.

### Dead ends (recorded so we don't repeat them)
- **Environment shims** (polyfill `performance`, `substr`, etc. into the Host): treated the symptom.
  `substr` was never actually missing — it was the masked symptom of the `h` collision. The Host
  *does* lack `performance`/`structuredClone`/`TextEncoder`/`crypto`/`btoa` etc., but the bake path
  doesn't need them once Strudel runs in a clean process.
- Pinning `m`→plain mini / `emitMiniLocations:false` (offset is always emitted; no effect).
- `vm.createContext` repros are **unfaithful** — copying outer-realm intrinsics into the sandbox
  breaks `instanceof` and produces the same error for the wrong reason.

Lesson: when a browser/full-Node library misbehaves *only* inside an embedded host, isolate it in a
real child process before shimming the host one missing global at a time.

## How to run it in Live (the one remaining step)
See `extension/README.md`. Short version: Live 12.4.5+ Suite Beta → Preferences → Extensions →
enable Developer Mode; `cp extension/.env.example extension/.env` and set `EXTENSION_HOST_PATH`
to the beta `.app`; `cd extension && npm start`. Then right-click a Session clip slot →
"Strudel: Create & bake", play it, and right-click the clip → "Strudel: Bake next window" to
step the evolution. (Or load the `.ablx` directly without Developer Mode.)

## Licensing (two separate copyleft/confidentiality constraints)
- **Ableton SDK is confidential pre-release material.** Its license forbids distributing
  "the SDK or parts of it outside of your application" and bars disclosure to third parties.
  ⇒ `vendor/` is gitignored; never commit/push the SDK, its docs, `.tgz`, or examples. The
  compiled `.ablx` (your application *using* the SDK) is explicitly OK to distribute.
- **Strudel is AGPL-3.0** (proposal §8). We bundle `@strudel/*` into the worker (`dist/worker.cjs`),
  so a public release of the extension must be AGPL-3.0. The pure `src/bake.mjs` boundary stays
  clean so a future non-Strudel DSL shares nothing copyleft.

## Reusable code
- `src/bake.mjs` — pure Strudel→`NoteDescription[]` (`evaluatePattern`, `hapsToNotes`,
  `bakeCycles`). Plain Strudel; runs in any normal Node process (the M0 spike, the smoke harness,
  and the extension's child worker).
- `extension/src/worker.ts` — runs `bake.mjs` in the spawned child process; JSON in/out.
- `spikes/m0-headless.mjs` — M0 demo. `spikes/explore-haps.mjs` — hap-shape probe.
