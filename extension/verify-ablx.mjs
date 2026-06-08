// Pre-flight verification of a built .ablx — WITHOUT Ableton. Run: `npm run verify`.
//
// It unzips the archive, validates the manifest, loads the entry, simulates the Extension Host
// (a mock ActivationContext) to confirm `activate` registers its commands + context-menu actions,
// and then INVOKES a command so the packaged worker.cjs actually bakes a pattern and the notes
// flow back through a mocked clip write. It also sanity-checks editor.html.
//
// What it canNOT check (Live only): the managed-host process.execPath spawn, real clip mutation,
// and the modal webview rendering. Those still need a real install. But this catches packaging
// bugs (missing files), a broken manifest, load/activate errors, and a broken worker pipeline.
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

// 3. required files present (entry + the worker/editor this extension needs at runtime)
const entryPath = join(extractDir, manifest.entry);
const workerPath = join(extractDir, "dist/worker.cjs");
const editorPath = join(extractDir, "dist/editor.html");
await check("entry + worker.cjs + editor.html all bundled", () => {
  for (const [label, p] of [["entry", entryPath], ["worker.cjs", workerPath], ["editor.html", editorPath]]) {
    assert(existsSync(p), `${label} missing from archive (${p})`);
  }
  return "4 files";
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

// 5. simulate the Host: call activate with a mock ActivationContext, confirm registrations.
const registered = new Map(); // commandId -> callback
const menus = []; // { scope, title, commandId }
const captured = { notes: null }; // notes written via the mocked clip
await check("activate() registers commands + context-menu actions", () => {
  const dataModelBase = {
    getRoot: () => ({ id: 0n }),
    getObjectIsOfClass: (h, cls) => (h.id === 0n ? cls === "Application" : cls === "MidiClip"),
    getObjectCanonicalParent: () => null,
    withinTransaction: (f) => f(),
    clipGetStartTime: () => 0,
    clipGetEndTime: () => 16, // duration 16 beats -> 4 bars
    midiclipSetNotes: (_h, notes) => {
      captured.notes = notes;
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
      showModalDialog: () => {},
      showProgressDialog: () => {},
    },
  };
  const activation = { hostApiVersion: "1.0.0", initializeExtensionHost: () => api };
  activate(activation);
  assert(registered.size >= 1, "no commands registered");
  assert(menus.length >= 1, "no context-menu actions registered");
  return `${registered.size} commands, ${menus.length} menu actions (${menus.map((m) => m.scope).join("/")})`;
});

// 6. drive a real bake: invoke a registered command so the PACKAGED worker.cjs runs.
await check("invoking a command bakes via the packaged worker.cjs", async () => {
  const cmd = [...registered.keys()].find((id) => /bakeNext|bake/i.test(id)) ?? [...registered.keys()][0];
  assert(cmd, "no command to invoke");
  await registered.get(cmd)({ id: 1n }); // a mock MidiClip handle
  const n = captured.notes;
  assert(Array.isArray(n) && n.length > 0, "no notes were written to the (mock) clip");
  const ok = n.every((x) => Number.isInteger(x.pitch) && x.pitch >= 0 && x.pitch <= 127 && typeof x.startTime === "number");
  assert(ok, "baked notes have invalid shape");
  return `${cmd} -> ${n.length} notes (pitches ${n.slice(0, 6).map((x) => x.pitch).join(" ")}…)`;
});

// 7. editor.html sanity
await check("editor.html is assembled (CodeMirror + init placeholder)", () => {
  const html = readFileSync(editorPath, "utf8");
  assert(/EditorView|cm-editor|codemirror/i.test(html), "no CodeMirror in editor.html");
  assert(html.includes("__STRUDELTON_INITIAL_JSON__"), "init placeholder missing (extension injects it at runtime)");
  assert(!html.includes("/*__EDITOR_BUNDLE__*/"), "editor bundle was not inlined");
  return `${(html.length / 1024).toFixed(0)}kb`;
});

if (extractDir) rmSync(extractDir, { recursive: true, force: true });
console.log(
  failures === 0
    ? "\n✅ .ablx verified (structure, manifest, activate, worker bake, editor). Live-only: managed-host spawn + real clip write still need an install.\n"
    : `\n❌ ${failures} check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
