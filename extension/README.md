# strudelton (extension)

Bakes a [Strudel](https://strudel.cc) pattern into Ableton MIDI clips. Probe build — see
[`../FINDINGS.md`](../FINDINGS.md) for why this is an offline *bake* and not the transport-driven
"living window" the proposal imagined (the SDK 1.0.0-beta.0 exposes no transport position and no
persistent webview).

## What it does

- **Right-click a Session clip slot → "Strudel: Create & bake"** — creates a fresh MIDI clip
  exactly one cycle (4 beats) long and bakes cycle 0 of the pattern into it.
- **Right-click a MIDI clip → "Strudel: Bake next window"** — advances that clip's window by N
  cycles and overwrites its notes, so you can step through the pattern's deterministic evolution
  by hand. (Manual stand-in for the transport clock the SDK can't give us.)

The pattern is hardcoded in [`src/extension.ts`](src/extension.ts) (`DEFAULT_PATTERN`) for now.

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
npm run package                   # -> strudelton-0.1.0.ablx, then install it into Live
```

## Verify the Strudel engine without Live

```bash
npm run smoke                     # bundles + runs the engine in Node, prints per-cycle notes
```

## Architecture: Strudel runs in a child process

The extension (`dist/extension.js`, ~35 kb, **no Strudel**) is a thin client. On each bake it
spawns a clean child `node` process running `dist/worker.cjs` (which bundles Strudel + the canonical
[`../src/bake.mjs`](../src/bake.mjs)), passes the request as base64 JSON, and reads notes back as
JSON from stdout. This is mandatory, not incidental: the Extension Host's V8 is bare + shared-scope
and breaks Strudel's `evalScope` in-process. A normal child `node` has a normal environment, so
Strudel just works. Full write-up in [`../FINDINGS.md`](../FINDINGS.md) §"why a child process".

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

- Loop markers are read-only after clip creation, so "Bake next window" overwrites notes in place
  and keeps the clip length; it infers N from the clip's current length.
- A bake spawns a short-lived `node` process (~few hundred ms) — fine for manual baking.
- `cannot use window: not in browser?` on the worker's startup is a benign Strudel browser-probe
  (it goes to the worker's stderr; stdout carries only the JSON result).
