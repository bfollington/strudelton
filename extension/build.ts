import * as esbuild from "esbuild";
import * as fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const production = process.argv.includes("--production");

const common = {
  bundle: true,
  format: "cjs" as const,
  platform: "node" as const,
  sourcesContent: false,
  logLevel: "info" as const,
  sourcemap: !production,
};

// The extension (loaded by Live's Extension Host). Thin: spawns the worker for Strudel work,
// and reads dist/editor.html at runtime for the modal editor.
await esbuild.build({
  ...common,
  entryPoints: ["src/extension.ts"],
  outfile: manifest.entry,
  minify: production,
});

// The Strudel bake worker — runs in a clean child Node process spawned by the extension.
await esbuild.build({
  ...common,
  entryPoints: ["src/worker.ts"],
  outfile: "dist/worker.cjs",
  minify: production,
});

// Standalone smoke harness: proves the bundled Strudel engine runs in a plain Node CJS module.
await esbuild.build({
  ...common,
  entryPoints: ["src/bundle-smoke.ts"],
  outfile: "dist/bundle-smoke.cjs",
  minify: false,
});

// Webview editor: bundle CodeMirror (browser/IIFE) and inline it into ui/shell.html -> dist/editor.html.
// The extension reads this file at runtime, injects the initial { code, bars }, and opens it as a
// modal dialog. CodeMirror runs in the webview (a real browser), not the bare Extension Host.
const editor = await esbuild.build({
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "safari15",
  minify: true, // always minify the webview bundle (keeps the inlined HTML smaller)
  sourcemap: false,
  write: false,
  logLevel: "info",
  entryPoints: ["ui/editor.ts"],
});
const editorJs = editor.outputFiles[0].text.replace(/<\/script>/gi, "<\\/script>"); // can't break out of <script>
const shell = fs.readFileSync("ui/shell.html", "utf8");
const assembled = shell.replace("/*__EDITOR_BUNDLE__*/", () => editorJs);
fs.writeFileSync("dist/editor.html", assembled);
console.log(`  dist/editor.html  ${(assembled.length / 1024).toFixed(1)}kb`);
