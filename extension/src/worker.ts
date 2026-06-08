// Strudel bake worker — runs in a CLEAN child Node process spawned by the extension.
//
// Why a separate process: Ableton's Extension Host runs the extension in a bare/shared-scope
// V8 where Strudel's `evalScope` (which injects its whole function library into the eval scope)
// collides with the Host's environment — e.g. mini's `h` clobbering core's `Fraction`, causing
// `t.substr`/stack-overflow crashes that don't happen in normal Node. A child `node` process has
// a normal environment and scope, so Strudel "just works" (every local test passes there).
//
// Protocol: argv[2] is base64(JSON) of { code, baseCycle, count, cfg }. We write JSON
// { ok, notes, skipped } (or { ok:false, error }) to stdout. ALL Strudel console noise is
// redirected to stderr so stdout carries only the result.

void (async () => {
  const toErr = (...a: unknown[]) => process.stderr.write(a.map(String).join(" ") + "\n");
  // Redirect before importing Strudel so its load banners don't pollute the stdout result.
  console.log = toErr;
  console.warn = toErr;
  console.info = toErr;

  try {
    const req = JSON.parse(Buffer.from(process.argv[2] ?? "", "base64").toString("utf8")) as {
      code: string;
      baseCycle?: number;
      count?: number;
      cfg?: { beatsPerCycle?: number; defaultVelocity?: number };
    };
    const { evaluatePattern, bakeCycles } = await import("../../src/bake.mjs");
    const { pattern } = await evaluatePattern(req.code);
    const { notes, skipped, ignoredControls } = bakeCycles(pattern, req.baseCycle ?? 0, req.count ?? 1, req.cfg ?? {});
    process.stdout.write(JSON.stringify({ ok: true, notes, skipped, ignoredControls }));
  } catch (e) {
    const err = e as Error;
    process.stdout.write(
      JSON.stringify({
        ok: false,
        error: String(err?.message),
        stack: String(err?.stack).split("\n").slice(0, 5).join(" | "),
      }),
    );
  }
})();
