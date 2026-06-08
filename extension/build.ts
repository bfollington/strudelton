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
  loader: { ".html": "text" as const }, // import the webview UI as a string
};

// The extension (loaded by Live's Extension Host). Thin: spawns the worker for Strudel work.
await esbuild.build({
  ...common,
  entryPoints: ["src/extension.ts"],
  outfile: manifest.entry,
  minify: production,
});

// The Strudel bake worker — runs in a clean child Node process spawned by the extension.
// Bundles Strudel; this is where the engine actually runs.
await esbuild.build({
  ...common,
  entryPoints: ["src/worker.ts"],
  outfile: "dist/worker.cjs",
  minify: production,
});

// Standalone smoke harness: proves the bundled Strudel engine runs in a plain Node CJS module.
// Runnable without Live via `npm run smoke`.
await esbuild.build({
  ...common,
  entryPoints: ["src/bundle-smoke.ts"],
  outfile: "dist/bundle-smoke.cjs",
  minify: false,
});
