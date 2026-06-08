// strudelton — Ableton Live extension (probe). Bakes a Strudel pattern into MIDI clips.
//
// Architecture (see ../../FINDINGS.md):
//   • The proposal's transport-driven "living window" is NOT buildable on Extensions SDK
//     1.0.0-beta.0 (no playhead/transport read, no persistent webview). This is the supported
//     alternative: an OFFLINE BAKE driven by context-menu commands.
//   • Strudel does NOT run in-process: the Extension Host's bare/shared-scope V8 breaks
//     Strudel's `evalScope`. Instead we spawn a clean child `node` process (dist/worker.cjs)
//     that runs Strudel normally and returns notes as JSON. The extension is a thin client.
//
//   • ClipSlot → "Strudel: Create & bake"  — fresh MIDI clip of one window, bake cycle 0.
//   • MidiClip → "Strudel: Bake next window" — advance this clip's window, overwrite notes.

import {
  initialize,
  type ActivationContext,
  type Handle,
  ClipSlot,
  MidiClip,
} from "@ableton-extensions/sdk";
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { BakedNote } from "../../src/bake.mjs";

const API_VERSION = "1.0.0";

// Hardcoded for M2. Becomes editable once we add the modal CodeMirror editor.
const DEFAULT_PATTERN = 'note("c3 e3 g3 b3 a3 g3 e3 d3").degradeBy(0.3)';
const CFG = { beatsPerCycle: 4, defaultVelocity: 100 };
const CYCLES_PER_CLIP = 1; // window size in cycles

// Per-clip window cursor: handle.id (bigint) -> next baseCycle to bake. Survives across
// command invocations because the Extension Host process stays alive (FINDINGS §Q1).
const nextBase = new Map<bigint, number>();

interface BakeRequest {
  code: string;
  baseCycle: number;
  count: number;
  cfg: typeof CFG;
}
interface BakeResult {
  notes: BakedNote[];
  skipped: number;
}

// Run a bake in the clean child Node process. Spawns dist/worker.cjs with the request as
// base64 JSON in argv; the worker writes a JSON result to stdout (console noise -> stderr).
function bakeViaWorker(req: BakeRequest): Promise<BakeResult> {
  return new Promise((resolve, reject) => {
    const workerPath = join(__dirname, "worker.cjs");
    const payload = Buffer.from(JSON.stringify(req)).toString("base64");
    const child = spawn(process.execPath, [workerPath, payload], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => reject(new Error(`spawn failed: ${e.message}`)));
    child.on("close", () => {
      let parsed: { ok: boolean; notes?: BakedNote[]; skipped?: number; error?: string; stack?: string };
      try {
        parsed = JSON.parse(out.trim());
      } catch {
        reject(new Error(`worker produced no JSON. stdout=${out.slice(0, 200)} stderr=${err.slice(0, 200)}`));
        return;
      }
      if (parsed.ok) resolve({ notes: parsed.notes ?? [], skipped: parsed.skipped ?? 0 });
      else reject(new Error(`worker error: ${parsed.error}${parsed.stack ? " | " + parsed.stack : ""}`));
    });
  });
}

export function activate(activation: ActivationContext) {
  const context = initialize(activation, API_VERSION);

  // ClipSlot scope: create a fresh clip sized to the window, bake cycle 0.
  context.commands.registerCommand("strudelton.bakeNew", async (arg: unknown) => {
    try {
      const slot = context.getObjectFromHandle(arg as Handle, ClipSlot);
      const lengthBeats = CYCLES_PER_CLIP * CFG.beatsPerCycle;
      const { notes, skipped } = await bakeViaWorker({
        code: DEFAULT_PATTERN,
        baseCycle: 0,
        count: CYCLES_PER_CLIP,
        cfg: CFG,
      });
      if (slot.clip) await slot.deleteClip(); // we control the clip length
      const clip = await slot.createMidiClip(lengthBeats);
      clip.notes = notes; // atomic clear + write (midiclipSetNotes)
      nextBase.set(clip.handle.id, CYCLES_PER_CLIP);
      console.log(
        `[strudelton] new clip (${lengthBeats} beats): cycle 0 -> ${notes.length} notes` +
          (skipped ? `, ${skipped} skipped (no pitch)` : ""),
      );
    } catch (e) {
      console.error("[strudelton] bakeNew failed:", e);
    }
  });

  // MidiClip scope: advance THIS clip's window and overwrite notes in place.
  context.commands.registerCommand("strudelton.bakeNext", async (arg: unknown) => {
    try {
      const clip = context.getObjectFromHandle(arg as Handle, MidiClip);
      const base = nextBase.get(clip.handle.id) ?? CYCLES_PER_CLIP;
      const n = Math.max(1, Math.round(clip.duration / CFG.beatsPerCycle)); // infer N from clip length
      const { notes } = await bakeViaWorker({ code: DEFAULT_PATTERN, baseCycle: base, count: n, cfg: CFG });
      clip.notes = notes;
      nextBase.set(clip.handle.id, base + n);
      console.log(`[strudelton] bake next window [${base}, ${base + n}) -> ${notes.length} notes`);
    } catch (e) {
      console.error("[strudelton] bakeNext failed:", e);
    }
  });

  context.ui.registerContextMenuAction("ClipSlot", "Strudel: Create & bake", "strudelton.bakeNew");
  context.ui.registerContextMenuAction("MidiClip", "Strudel: Bake next window", "strudelton.bakeNext");

  console.log("[strudelton] activated — right-click a Session clip slot, or a MIDI clip.");
}
