# strudelton (extension)

Bakes a [Strudel](https://strudel.cc) pattern into Ableton MIDI clips. Probe build — see
[`../FINDINGS.md`](../FINDINGS.md) for why this is an offline *bake* and not the transport-driven
"living window" the proposal imagined (the SDK 1.0.0-beta.0 exposes no transport position and no
persistent webview).

## What it does

- **Right-click a Session clip slot → "Strudel: Edit & bake…"** — opens a CodeMirror editor with a
  live piano-roll; write a pattern, set how many **bars** to bake, hit **Bake**. The notes land in a
  fresh looping MIDI clip of that length.
- **Right-click a MIDI clip → "Strudel: Edit & bake…"** — reopens that clip's pattern to re-bake
  (resizes the clip if you change the bar count).

The default pattern shows velocity (accents) + per-note probability (Live re-rolls it each loop, so
the clip evolves as it plays). Both menu items run the same modal editor, which has a **? cheatsheet**
toggle covering what bakes (scales, chords, arps, velocity, probability, drums), the Strudel-vs-Ableton
octave convention, and what's ignored.

## Prerequisites

- **Node 24** — pinned via `../mise.toml` (`mise install`). The Extension Host needs ≥22.11.
- **Ableton Live 12.4.5+ Suite Beta** (Extensions are Suite-only, beta-gated via Centercode).

## Two ways to run — pick one

Both run the *same* built `dist/extension.js`. They differ only in **who launches the Extension
Host** (your terminal vs. Live) and **whether you install an artifact**.

### A) Developer Mode + `npm start` — for testing/iteration (no install, no `.ablx`)

`npm start` does **not** auto-discover or launch Ableton. It launches the *Extension Host* (a
module that ships inside `Live.app`) and connects it to an **already-running** Live. Three
prerequisites make that work:

1. **Live (the beta) is running.**
2. **Developer Mode is ON** — Live → Preferences → Extensions. Required: normally Live runs its
   own host; Developer Mode makes it stand down so the host *you* launch can connect instead.
   Without it, `npm start` cannot connect.
3. **`.env` → `EXTENSION_HOST_PATH` points at your Live beta `.app`** — this is how it "finds"
   Ableton; it borrows the host module from inside that bundle.

```bash
mise install                      # ensures Node 24.16.0
cd extension
npm install                       # pulls SDK+CLI from ../vendor/sdk/*.tgz
cp .env.example .env              # set EXTENSION_HOST_PATH -> your actual Live beta .app path
# launch the Live beta, enable Developer Mode, then:
npm start                         # builds (dev) + loads the extension into the running Live
```

`console.log` output appears in the terminal running `npm start`. Edit code → re-run `npm start`
to reload (no Live restart needed).

### B) Package an `.ablx` + install — for real use / sharing (Developer Mode OFF)

Only needed when you want the extension installed permanently or handed to someone else. Live then
manages its own host and auto-loads the extension on startup.

```bash
npm run package                   # -> strudelton-0.2.0.ablx, then install it into Live
```

## Verify without Live

```bash
npm run smoke      # bundles + runs the Strudel engine in Node, prints per-cycle notes
npm run verify     # builds the .ablx, then pre-flights it: structure, manifest, loads the entry,
                   # mocks the Extension Host to run activate() (registers commands/menus), and
                   # drives editSlot end-to-end — a mocked modal returns notes that must reach a clip.
```

`npm run smoke` exercises the real Strudel engine (the same one the webview runs). `npm run verify`
catches packaging bugs (missing files), a broken manifest, load/activate errors, and a broken
note-write path. Neither can render the actual webview or mutate a real clip — install the `.ablx`
once to confirm those. (The webview bake itself is verified separately against a real browser.)

## Architecture: Strudel runs in the webview

The extension (`dist/extension.js`, **no Strudel**, no filesystem, no child process) is a thin client
that only makes SDK calls. Strudel can't run in the Extension Host (its V8 is bare + shared-scope and
breaks Strudel's `evalScope`), and the *installed* Host sandboxes Node, so a child process / temp
files aren't options either. So the bake runs in the **modal webview** — a real browser — which also
hosts the live preview. `dist/editor.html` bundles CodeMirror + Strudel + the canonical
[`../src/bake.mjs`](../src/bake.mjs); the extension hands it to `showModalDialog` as a data: URL (read
at runtime, so editor.html stays a separate file from the proprietary SDK), the webview bakes, and
`close_and_send` returns `{code, bars, notes}` — which the extension writes to the clip. Full
write-up + the dead ends in [`../FINDINGS.md`](../FINDINGS.md) §"Architecture".

## Expression in patterns

- **Scales / keys / chords** — via `@strudel/tonal`: `.scale("C:minor")`, `n("0 2 4").scale(...)`,
  `<a:minor:pentatonic e:dorian>` (different scale per bar), `.voicing()`, chord symbols.
- **Drums** — `s("bd sd hh oh")` maps drum names → MIDI notes (GM-aligned, matches Ableton's
  default Drum Rack: first pad = C1 = 36). Put a Drum Rack on the track. Unknown sound names are
  skipped (shown in the preview's "N skipped"). Override the map via `cfg.drumMap` in `bake.mjs`.
- **Velocity** — `.velocity(x)` or `.gain(x)` (0–1) → MIDI velocity 1–127, per note.
- **Probability** — `.prob(p)` or `.chance(p)` (0–1) → Live's per-note probability. Live re-rolls
  it every loop, so the clip **evolves while it loops** with no re-bake. Example:
  `note("c3 e3 g3 b3").prob("1 0.6 0.85 0.5")`. (This is different from `degradeBy`, which drops
  notes deterministically when baked.)
- **MPE / continuous expression** is not possible — the SDK note API has no pitch-bend / pressure /
  note-expression / real-time MIDI (see [`../FINDINGS.md`](../FINDINGS.md) §"Expression ceiling").

## Notes / known constraints

- Loop markers are read-only after clip creation, so re-baking a clip recreates it at the new length
  (delete + `createMidiClip`) rather than moving markers.
- The editor loads as a ~1.3 MB base64 data: URL (CodeMirror + Strudel inlined). That's the SDK's
  documented webview mechanism; verified to load + bake in a real browser at that size.
- No "bake next window" anymore — it needed host-side Strudel, which the managed sandbox forbids.
  Per-note `.prob()` covers evolving playback; a future "bake next" could be a button in the editor
  (which has a webview).
