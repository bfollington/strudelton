// Pre-flight verification of a built .ablx — WITHOUT Ableton. Run: `npm run verify`.
//
// It unzips the archive, validates the manifest, loads the entry, simulates the Extension Host
// (a mock ActivationContext) to confirm `activate` registers its commands + context-menu actions,
// and then drives the managed-safe note path: a mocked modal returns notes (as the real webview
// would), and we assert they are written to a clip through the SDK. It also sanity-checks the
// bundled editor.html.
//
// What it canNOT check (Live only): the real webview rendering + Strudel bake, and real clip
// mutation. The Strudel engine itself is covered headlessly by `npm run smoke`. Together they catch
// packaging bugs (missing files), a broken manifest, load/activate errors, and a broken note-write
// path — leaving only the genuinely Live-only behavior for a one-time install check.
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ablx = process.argv[2] || findAblx();
let failures = 0;
let extractDir;

function findAblx() {
  const fs = require("node:fs");
  const f = fs.readdirSync(".").find((n) => n.endsWith(".ablx"));
  if (!f) throw new Error("no .ablx found in cwd — pass a path or run `npm run package` first");
  return f;
}
async function check(name, fn) {
  try {
    const detail = await fn();
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (e) {
    failures++;
    console.log(`  ✗ ${name} — ${e?.message ?? e}`);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

console.log(`\nVerifying ${ablx}\n`);

// 1. unzip
extractDir = mkdtempSync(join(tmpdir(), "ablx-verify-"));
await check("unzips", () => {
  execFileSync("unzip", ["-o", "-q", ablx, "-d", extractDir]);
  return extractDir;
});

// 2. manifest
let manifest;
await check("manifest.json valid + required fields", () => {
  const p = join(extractDir, "manifest.json");
  assert(existsSync(p), "manifest.json missing");
  manifest = JSON.parse(readFileSync(p, "utf8"));
  for (const k of ["name", "author", "entry", "version", "minimumApiVersion"]) {
    assert(typeof manifest[k] === "string" && manifest[k].length, `manifest.${k} missing/empty`);
  }
  assert(manifest.minimumApiVersion === "1.0.0", `unexpected minimumApiVersion ${manifest.minimumApiVersion}`);
  return `${manifest.name} v${manifest.version}, entry=${manifest.entry}`;
});

// 3. required files: the entry + the bundled editor.html the modal loads via file://.
//    (No worker.cjs — Strudel runs in the webview now, not a child process.)
const entryPath = join(extractDir, manifest.entry);
const editorPath = join(extractDir, "dist/editor.html");
await check("entry + editor.html bundled (and no stale worker.cjs)", () => {
  assert(existsSync(entryPath), `entry missing from archive (${entryPath})`);
  assert(existsSync(editorPath), `editor.html missing from archive (${editorPath})`);
  assert(!existsSync(join(extractDir, "dist/worker.cjs")), "stale worker.cjs is still bundled");
  return "entry + editor.html";
});

// 4. load the entry exactly as a CJS loader would, and grab activate
let activate;
await check("entry loads + exports activate()", () => {
  const src = readFileSync(entryPath, "utf8");
  const mod = { exports: {} };
  const dir = join(extractDir, "dist");
  const fn = new Function("module", "exports", "require", "__dirname", "__filename", src);
  fn(mod, mod.exports, require, dir, entryPath);
  activate = mod.exports.activate;
  assert(typeof activate === "function", "module does not export an activate() function");
  return "loaded clean";
});

// 5. simulate the Host: activate with a mock ActivationContext, confirm registrations. The mocked
//    modal returns notes the way the real webview would (close_and_send payload).
const registered = new Map(); // commandId -> callback
const menus = []; // { scope, title, commandId }
const captured = { notes: null };

// Notes the "webview" returns — a realistic NoteDescription[] (origin/engine is smoke's job).
const bakedNotes = [
  { pitch: 48, startTime: 0, duration: 1, velocity: 127 },
  { pitch: 52, startTime: 1, duration: 1, velocity: 89, probability: 0.7 },
  { pitch: 55, startTime: 2, duration: 1, velocity: 114 },
  { pitch: 59, startTime: 3, duration: 1, velocity: 76, probability: 0.5 },
];
const modalResult = JSON.stringify({ code: 'note("c3 e3 g3 b3")', bars: 2, notes: bakedNotes });

await check("activate() registers commands + context-menu actions", () => {
  const dataModelBase = {
    getRoot: () => ({ id: 0n }),
    // 0n -> Application, 7n -> the ClipSlot we invoke with, everything else -> a created MidiClip.
    getObjectIsOfClass: (h, cls) =>
      h.id === 0n ? cls === "Application" : h.id === 7n ? cls === "ClipSlot" : cls === "MidiClip",
    getObjectCanonicalParent: () => null,
    withinTransaction: (f) => f(),
    clipGetStartTime: () => 0,
    clipGetEndTime: () => 16, // duration 16 beats -> 4 bars
    clipslotGetClip: () => null, // empty slot
    clipslotDeleteClip: (_h, onResult) => onResult && onResult(),
    clipslotCreateMidiClip: (_h, _len, onResult) => onResult({ id: 99n }),
    midiclipSetNotes: (_h, n) => {
      captured.notes = n;
    },
  };
  const api = {
    commands: { registerCommand: (id, cb) => registered.set(id, cb), executeCommand: () => {} },
    dataModel: new Proxy(dataModelBase, { get: (t, p) => (p in t ? t[p] : () => undefined) }),
    environment: { storageDirectory: extractDir, tempDirectory: extractDir, language: "EN" },
    resources: new Proxy({}, { get: () => () => {} }),
    ui: {
      registerContextMenuAction: (scope, title, commandId, onSuccess) => {
        menus.push({ scope, title, commandId });
        onSuccess(() => Promise.resolve());
      },
      showModalDialog: (_url, _w, _h, onResult) => onResult(modalResult),
      showProgressDialog: () => {},
    },
  };
  const activation = { hostApiVersion: "1.0.0", initializeExtensionHost: () => api };
  activate(activation);
  assert(registered.size >= 1, "no commands registered");
  assert(menus.length >= 1, "no context-menu actions registered");
  return `${registered.size} commands, ${menus.length} menu actions (${menus.map((m) => m.scope).join("/")})`;
});

// 6. drive editSlot: the mocked modal returns baked notes; they must reach the (mock) clip.
await check("invoking editSlot writes the webview's baked notes to a clip", async () => {
  const cmd = [...registered.keys()].find((id) => /editSlot/i.test(id)) ?? [...registered.keys()][0];
  assert(cmd, "no command to invoke");
  await registered.get(cmd)({ id: 7n }); // a mock ClipSlot handle
  const n = captured.notes;
  assert(Array.isArray(n) && n.length > 0, "no notes were written to the (mock) clip");
  assert(n.length === bakedNotes.length, `expected ${bakedNotes.length} notes, wrote ${n.length}`);
  const ok = n.every((x) => Number.isInteger(x.pitch) && x.pitch >= 0 && x.pitch <= 127 && typeof x.startTime === "number");
  assert(ok, "baked notes have invalid shape");
  return `${cmd} -> ${n.length} notes (pitches ${n.map((x) => x.pitch).join(" ")})`;
});

// 7. editor.html sanity
await check("editor.html is assembled (CodeMirror + bundle inlined)", () => {
  const html = readFileSync(editorPath, "utf8");
  assert(/EditorView|cm-editor|codemirror/i.test(html), "no CodeMirror in editor.html");
  assert(!html.includes("/*__EDITOR_BUNDLE__*/"), "editor bundle was not inlined");
  assert(!html.includes("__STRUDELTON_INITIAL_JSON__"), "stale injection placeholder still present");
  return `${(html.length / 1024).toFixed(0)}kb`;
});

if (extractDir) rmSync(extractDir, { recursive: true, force: true });
console.log(
  failures === 0
    ? "\n✅ .ablx verified (structure, manifest, activate, note-write path, editor). Live-only: the real webview bake + clip mutation still need an install.\n"
    : `\n❌ ${failures} check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
