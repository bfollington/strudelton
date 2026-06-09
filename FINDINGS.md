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
| M2 bake extension | ✅ **WORKING IN LIVE** | right-click a Session clip slot / MIDI clip → "Strudel: Edit & bake…" opens a CodeMirror+preview modal; Bake writes the pattern's notes into a real MIDI clip. Runs **installed (managed)**, not just Developer Mode. |
| M3 living window | ❌ blocked | no transport, no persistent webview — pivoted to bake; per-note `probability` gives evolve-while-looping without a clock |

**Chosen direction:** offline bake via a modal editor, confirmed working in Live 12.4.5b3. The
extension is a thin client (no Strudel, no filesystem, no child process); Strudel runs in the modal
**webview**, which previews *and* bakes, then returns the notes (see §"Architecture").

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

**Implemented: #2 (modal editor), with the bake running *in the webview* — not a child process
(see §Architecture). #1's through-composed N-cycle bake is exactly what the editor's "Bars" control
does. #3 ("bake next window") was dropped: it needs host-side Strudel, which the managed sandbox
forbids.**

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

## Architecture — Strudel runs in the webview (two hard-won lessons)

**Lesson 1 — do NOT run Strudel inside the Extension Host process.** We tried (bundle `@strudel/*`
into the extension and call it in-process) and burned a day on it. The Host runs the extension in a
V8 that is both **bare** (missing `performance` — `@strudel/core` calls `performance.now()` at load)
and, fatally, **shared-scope**: Strudel's `evalScope()` injects its entire function library into the
eval scope, and in the Host that scope is resolved in a way that makes those injected names collide
with the bundle's own bindings. Concretely:
- `@strudel/mini` exports `h` (its raw mini-reify, which feeds its argument to the peg parser).
  `@strudel/core`'s step/tactus code calls `h(<number>)` expecting `Fraction`. In the Host, core's
  call resolved to mini's `h` instead → the parser tried to `.substr` a number → crash. Strudel's
  `mini2ast` catch *masked* it (it assumed a peggy `SyntaxError` with `.location` and crashed on
  `.location.start` → the red-herring `reading 'start' of undefined`).
- Every targeted fix surfaced the next collision (e.g. pinning `h`→`Fraction` then hit a different
  binding → infinite recursion). It is unwinnable in-process.

**Lesson 2 — a child `node` process works in Developer Mode but NOT when installed.** Our first fix
ran the bake in a clean child process: `spawn(process.execPath, ['worker.cjs', …])`. That works
under `extensions-cli run` (Developer Mode), where *we* launch the Host with a normal Node — and it
fooled us into shipping it. But the **installed / managed Host runs under Node's permission
sandbox** (`--permission`): `fs` writes are denied (`ERR_ACCESS_DENIED` — the editor's temp-file
write crashed on the very first managed install) and `process.execPath` is not a Node binary we can
relaunch. The SDK docs are explicit: extensions may only touch `storageDirectory`/`tempDirectory`,
and "child processes … must respect the same restrictions." So the child-process design is a
Developer-Mode-only mirage.

**The answer: run Strudel where a real browser already exists — the modal webview.** The SDK's only
UI surface, `showModalDialog(url)`, loads a full browser. We were already running Strudel there for
the live piano-roll preview; now the **bake happens there too**. No host-side Strudel, no child
process, no filesystem:

```
Extension Host (extension.js, ~17 kb min, NO Strudel, no fs, no spawn)
  └─ showModalDialog( "data:text/html;base64,<editor.html>#<{code,bars}>" )   ← documented pattern
        editor.html (CodeMirror + @strudel/*) evaluates, previews, and BAKES in the webview
        → close_and_send( JSON {code, bars, notes} )    ← the one string a modal can return
  ← extension writes notes to the clip via the SDK (clipSlot.createMidiClip + clip.notes = notes)
```

`extension/ui/editor.ts` is the whole Strudel side (preview + bake), bundled into `dist/editor.html`;
`extension/src/extension.ts` reads that file at runtime, hands it to the modal as a data: URL (initial
`{code,bars}` in the URL fragment), and writes back the returned notes. Verified end-to-end in a real
browser (headless Chrome over CDP): a 1.26 MB data: URL loads, seeds from the fragment, previews, and
the Bake button posts `close_and_send` with correctly-shaped notes (velocity + probability intact).

### Build toolchain
`tsc --noEmit && tsx build.ts` (esbuild) emits `dist/extension.js` (thin client, CJS),
`dist/editor.html` (CodeMirror + Strudel, browser IIFE inlined into the shell), and
`dist/bundle-smoke.cjs` (`npm run smoke`, runs the engine in plain Node without Live).
`extensions-cli package . --include dist/editor.html` makes an installable `strudelton-<ver>.ablx`.
`npm run verify` pre-flights it without Live; `extensions-cli run` (Developer Mode) loads it live.

### Dead ends (recorded so we don't repeat them)
- **Environment shims** (polyfill `performance`, `substr`, etc. into the Host): treated the symptom.
  `substr` was never actually missing — it was the masked symptom of the `h` collision. The Host
  *does* lack `performance`/`structuredClone`/`TextEncoder`/`crypto`/`btoa` etc., but the bake path
  doesn't need them once Strudel runs in a clean process.
- Pinning `m`→plain mini / `emitMiniLocations:false` (offset is always emitted; no effect).
- `vm.createContext` repros are **unfaithful** — copying outer-realm intrinsics into the sandbox
  breaks `instanceof` and produces the same error for the wrong reason.
- **Child-process worker** (`spawn(process.execPath, ['worker.cjs'])`) — ran Strudel in a clean Node
  and worked perfectly in Developer Mode, so we shipped it… then the **installed** Host sandboxes
  Node (permission model): the editor's temp-file write was denied (`ERR_ACCESS_DENIED`) and
  `process.execPath` isn't a relaunchable Node. **Test installed, not just Developer Mode.** Don't
  design around host-side `fs`/`child_process` — the webview is the only place a full runtime is
  guaranteed (it bakes there now; temp-file editor write + worker both deleted).

Lesson: when a browser/full-Node library misbehaves *only* inside an embedded host, isolate it in a
real child process before shimming the host one missing global at a time.

## How to run it in Live
Two ways (see `extension/README.md`): **(A)** install the packaged `.ablx` (Developer Mode OFF) —
`cd extension && npm run package`, then add the archive in Preferences → Extensions; **(B)**
Developer Mode for iteration — `cp extension/.env.example extension/.env`, set `EXTENSION_HOST_PATH`
to the beta `.app`, `npm start`. Either way: right-click a Session clip slot (or a MIDI clip) →
"Strudel: Edit & bake…", write a pattern, set bars, Bake.

## Licensing (two separate copyleft/confidentiality constraints)
- **Ableton SDK is confidential pre-release material.** Its license forbids distributing
  "the SDK or parts of it outside of your application" and bars disclosure to third parties.
  ⇒ `vendor/` is gitignored; never commit/push the SDK, its docs, `.tgz`, or examples. The
  compiled `.ablx` (your application *using* the SDK) is explicitly OK to distribute.
- **Strudel is AGPL-3.0** (proposal §8), so a public release of the extension is AGPL-3.0. `@strudel/*`
  is bundled **only** into `dist/editor.html` (the webview); the proprietary SDK is bundled **only**
  into `dist/extension.js`. They stay SEPARATE files — the extension reads editor.html at runtime and
  hands it to the webview as a data: URL, so the two never link into one binary. (Ableton's own
  example `import`-inlines its HTML into extension.js; we deliberately don't, to keep the
  AGPL/proprietary split.) The pure `src/bake.mjs` boundary stays clean for a future non-Strudel DSL.

## Reusable code
- `src/bake.mjs` — pure Strudel→`NoteDescription[]` (`evaluatePattern`, `hapsToNotes`,
  `bakeCycles`). Plain Strudel; runs anywhere — the M0 spike, the smoke harness (Node), and the
  modal webview (browser).
- `extension/ui/editor.ts` — the webview UI: CodeMirror + live piano-roll preview + the bake;
  bundled into `dist/editor.html`.
- `spikes/m0-headless.mjs` — M0 demo. `spikes/explore-haps.mjs` — hap-shape probe.
