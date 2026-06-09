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

// The extension (loaded by Live's Extension Host). It does NO Strudel work and NO filesystem I/O:
// it points the modal at the bundled editor.html (file://) and writes the notes the webview bakes
// back into the clip via the SDK. No worker, no temp files, no child_process (the managed host's
// permission sandbox forbids all three).
await esbuild.build({
  ...common,
  entryPoints: ["src/extension.ts"],
  outfile: manifest.entry,
  minify: production,
});

// Standalone smoke harness: proves the bundled Strudel engine runs in a plain Node CJS module
// (the engine the webview runs — verified headlessly here, with no Ableton).
await esbuild.build({
  ...common,
  entryPoints: ["src/bundle-smoke.ts"],
  outfile: "dist/bundle-smoke.cjs",
  minify: false,
});

// Webview editor: bundle CodeMirror + Strudel (browser/IIFE) and inline it into ui/shell.html ->
// dist/editor.html. This standalone file is the WHOLE Strudel side: it evaluates the pattern, shows
// the live piano-roll, AND bakes on demand. The extension only opens it as a modal (file://) and
// reads back the notes, so Strudel (AGPL) and the SDK (proprietary) stay in SEPARATE files.
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
