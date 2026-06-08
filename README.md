# strudelton

Author [Strudel](https://strudel.cc) patterns and bake them into Ableton Live MIDI clips — as a
Live **Extension** (Extensions SDK, Live 12.4.5+ Suite beta). A built-in CodeMirror editor with a
live piano-roll preview turns a Strudel pattern into notes in a clip: melodies, drums, scales,
velocity, and per-note probability that re-rolls every loop.

> **Status:** a working probe (see [`PROPOSAL.md`](PROPOSAL.md) for the original brief and
> [`FINDINGS.md`](FINDINGS.md) for what it taught us). Tested in Live 12.4.5 beta in Developer Mode.

![editor](docs/editor.png)

## What it does

- **Right-click a Session clip slot → "Strudel: Edit & bake…"** — opens the editor; write a pattern,
  set how many **bars** to bake, hit **Bake**. The pattern's notes land in a fresh looping MIDI clip.
- **Right-click a MIDI clip → "Strudel: Edit & bake…"** — re-open that clip's pattern and re-bake.
- **Right-click a MIDI clip → "Strudel: Bake next window"** — step the pattern's deterministic
  evolution forward by N bars (no editor).
- **Live preview** in the editor: a piano-roll of exactly what will bake, transpile errors inline,
  and a flag for sound-only controls that get dropped (`speed`, `lpf`, …).

### Supported in patterns
- Full Strudel core + mini-notation, **scales/keys/chords** (`@strudel/tonal`), **drums**
  (`s("bd sd hh")` → Drum Rack), **velocity** (`.velocity()`/`.gain()`), and **probability**
  (`.prob()`/`.chance()` → Live re-rolls each loop).
- Sound-engine controls (`.lpf()`, `.room()`, `.speed()`, …) evaluate but are **dropped** — this
  bakes notes, not sound (do sound design on the Ableton track). The editor flags them.
- Not possible via the SDK: MPE / per-note pitch-bend / continuous automation (no such API).

## Architecture (in one breath)

The Extension Host runs a bare, shared-scope V8 that breaks Strudel's `evalScope` in-process, so:

```
Extension Host  ──spawn──▶  child `node` (worker.cjs, Strudel)  ──notes JSON──▶  write to clip (SDK)
  (thin client)            modal editor (editor.html, CodeMirror + Strudel preview, file://)
```

The extension is a thin client; Strudel runs in a clean child process and in the webview. See
[`FINDINGS.md`](FINDINGS.md) for the full story (and the dead ends).

## Build & run

Requires **Node 24** (pinned via [`mise.toml`](mise.toml)) and **Ableton Live 12.4.5+ Suite beta**.

```bash
mise install                       # Node 24.16.0
# Obtain the Extensions SDK first — see "The SDK is not included" below.
cd extension
npm install                        # resolves the SDK + CLI from vendor/sdk/*.tgz
cp .env.example .env               # set EXTENSION_HOST_PATH to your Live beta .app
# In Live: Preferences → Extensions → enable Developer Mode, then:
npm start                          # builds + loads the extension into the running Live
```

Then use the context-menu actions above. More detail in [`extension/README.md`](extension/README.md).

To make an installable archive (Developer Mode off): `cd extension && npm run package` →
`strudelton-<version>.ablx`. Pre-built `.ablx` files are attached to the [Releases](../../releases).

## The SDK is not included

The **Ableton Extensions SDK is confidential pre-release material** and its license forbids
redistributing it. So this repo does **not** contain it — `vendor/` is gitignored. To build,
obtain the SDK zip from Ableton (Centercode beta) and extract it so these exist:

```
vendor/sdk/ableton-extensions-sdk-1.0.0-beta.0.tgz
vendor/sdk/ableton-extensions-cli-1.0.0-beta.0.tgz
```

`extension/package.json` resolves the SDK + CLI from those paths. (The packaged `.ablx` bundles the
SDK's runtime wrapper *inside your application*, which the SDK license explicitly permits.)

## License

**AGPL-3.0** (see [`LICENSE`](LICENSE)) — required because the bake engine links
[Strudel](https://strudel.cc), which is AGPL-3.0. All of this project's own source is here.

Dependency licenses:
- `@strudel/*` — **AGPL-3.0** (bundled into `worker.cjs` and `editor.html`).
- `@ableton-extensions/sdk` — **proprietary** (Ableton; not included; bundled into `extension.js`).
- CodeMirror, `@tonaljs/tonal`, etc. — permissive (MIT-ish).

Strudel (AGPL) and the Ableton SDK (proprietary) are bundled into **separate** files that only
communicate across a process/file boundary — they are never linked into one binary.
