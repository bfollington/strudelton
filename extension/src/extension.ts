// strudelton — Ableton Live extension (probe). Bakes a Strudel pattern into MIDI clips.
//
// Architecture (see ../../FINDINGS.md):
//   • The proposal's transport-driven "living window" is NOT buildable on Extensions SDK
//     1.0.0-beta.0 (no playhead/transport read, no persistent webview). This is the supported
//     alternative: an OFFLINE BAKE driven by context-menu commands + a modal editor.
//   • Strudel does NOT run in-process: the Extension Host's bare/shared-scope V8 breaks
//     Strudel's `evalScope`. Instead we spawn a clean child `node` process (dist/worker.cjs)
//     that runs Strudel normally and returns notes as JSON. The extension is a thin client.
//
// Commands:
//   • ClipSlot → "Strudel: Edit & bake…"    — open the editor, bake N bars into a fresh clip.
//   • MidiClip → "Strudel: Edit & bake…"    — reopen this clip's pattern, re-bake.
//   • MidiClip → "Strudel: Bake next window" — advance this clip's window by N bars (no editor).

import {
  initialize,
  type ActivationContext,
  type DataModelObject,
  type Handle,
  ClipSlot,
  MidiClip,
} from "@ableton-extensions/sdk";
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { BakedNote } from "../../src/bake.mjs";
import interfaceHtml from "../ui/interface.html";

const API_VERSION = "1.0.0";

// Showcases per-note velocity (accents) + probability (Live re-rolls each loop → evolving clip).
const DEFAULT_PATTERN =
  'note("c3 e3 g3 b3 a3 g3 e3 d3")\n' +
  '  .velocity("1 0.6 0.8 0.6 0.9 0.6 0.8 0.6")\n' +
  '  .prob("1 0.7 0.9 0.5 1 0.7 0.5 0.8")';
const DEFAULT_BARS = 4;
const CFG = { beatsPerCycle: 4, defaultVelocity: 100 };

// Per-clip state, keyed by handle.id (bigint). Survives across command invocations because the
// Extension Host process stays alive. `patterns` = the editable pattern + bar count for a clip;
// `nextBase` = the next base cycle for "Bake next window".
const patterns = new Map<bigint, EditorState>();
const nextBase = new Map<bigint, number>();

interface EditorState {
  code: string;
  bars: number;
}
interface BakeResult {
  notes: BakedNote[];
  skipped: number;
}

// Run a bake in the clean child Node process. Spawns dist/worker.cjs with the request as base64
// JSON in argv; the worker writes a JSON result to stdout (console noise -> stderr).
function bakeViaWorker(req: { code: string; baseCycle: number; count: number; cfg: typeof CFG }): Promise<BakeResult> {
  return new Promise((resolve, reject) => {
    const workerPath = join(__dirname, "worker.cjs");
    const payload = Buffer.from(JSON.stringify(req)).toString("base64");
    const child = spawn(process.execPath, [workerPath, payload], { stdio: ["ignore", "pipe", "pipe"] });
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

  // Open the modal editor seeded with `initial`; resolves to the edited state, or null if the
  // user dismissed it without baking.
  async function openEditor(initial: EditorState): Promise<EditorState | null> {
    const injected = JSON.stringify(initial).replace(/</g, "\\u003c"); // keep </script> from breaking the HTML
    // Function replacer so `$` in a pattern (e.g. Strudel's `$:` stacks) isn't treated as a
    // special replacement token. The placeholder appears exactly once in the HTML.
    const html = interfaceHtml.replace("__STRUDELTON_INITIAL__", () => injected);
    let result: string;
    try {
      result = await context.ui.showModalDialog(`data:text/html,${encodeURIComponent(html)}`, 620, 460);
    } catch {
      return null; // dismissed / closed without baking
    }
    try {
      const parsed = JSON.parse(result) as Partial<EditorState> & { cancel?: boolean };
      if (parsed.cancel || typeof parsed.code !== "string") return null; // Cancel / Escape
      return { code: parsed.code, bars: clampBars(parsed.bars ?? DEFAULT_BARS) };
    } catch {
      return null;
    }
  }

  // Bake `bars` cycles of `code` into the given slot as a fresh clip of the right length.
  async function bakeIntoSlot(slot: ClipSlot<"1.0.0">, code: string, bars: number): Promise<void> {
    const { notes, skipped } = await bakeViaWorker({ code, baseCycle: 0, count: bars, cfg: CFG });
    if (slot.clip) await slot.deleteClip(); // we control the clip length, so recreate
    const clip = await slot.createMidiClip(bars * CFG.beatsPerCycle);
    clip.notes = notes;
    patterns.set(clip.handle.id, { code, bars });
    nextBase.set(clip.handle.id, bars);
    console.log(`[strudelton] baked ${bars} bar(s) -> ${notes.length} notes` + (skipped ? `, ${skipped} skipped` : ""));
  }

  // ClipSlot → edit & bake into a fresh clip.
  context.commands.registerCommand("strudelton.editSlot", async (arg: unknown) => {
    try {
      const slot = context.getObjectFromHandle(arg as Handle, ClipSlot);
      const existing = slot.clip instanceof MidiClip ? patterns.get(slot.clip.handle.id) : undefined;
      const edited = await openEditor(existing ?? { code: DEFAULT_PATTERN, bars: DEFAULT_BARS });
      if (edited) await bakeIntoSlot(slot, edited.code, edited.bars);
    } catch (e) {
      console.error("[strudelton] editSlot failed:", e);
    }
  });

  // MidiClip → reopen this clip's pattern, edit & re-bake (resizes the clip if bars changed).
  context.commands.registerCommand("strudelton.editClip", async (arg: unknown) => {
    try {
      const clip = context.getObjectFromHandle(arg as Handle, MidiClip);
      const slot = asClipSlot(clip.parent);
      if (!slot) {
        console.error("[strudelton] editClip: clip has no ClipSlot parent (arrangement clip?) — not supported yet");
        return;
      }
      const initial = patterns.get(clip.handle.id) ?? {
        code: DEFAULT_PATTERN,
        bars: clampBars(Math.round(clip.duration / CFG.beatsPerCycle)),
      };
      const edited = await openEditor(initial);
      if (edited) await bakeIntoSlot(slot, edited.code, edited.bars);
    } catch (e) {
      console.error("[strudelton] editClip failed:", e);
    }
  });

  // MidiClip → step the window forward by `bars` using the clip's stored pattern (no editor).
  context.commands.registerCommand("strudelton.bakeNext", async (arg: unknown) => {
    try {
      const clip = context.getObjectFromHandle(arg as Handle, MidiClip);
      const state = patterns.get(clip.handle.id) ?? {
        code: DEFAULT_PATTERN,
        bars: clampBars(Math.round(clip.duration / CFG.beatsPerCycle)),
      };
      const base = nextBase.get(clip.handle.id) ?? state.bars;
      const { notes } = await bakeViaWorker({ code: state.code, baseCycle: base, count: state.bars, cfg: CFG });
      clip.notes = notes;
      nextBase.set(clip.handle.id, base + state.bars);
      console.log(`[strudelton] next window [${base}, ${base + state.bars}) -> ${notes.length} notes`);
    } catch (e) {
      console.error("[strudelton] bakeNext failed:", e);
    }
  });

  context.ui.registerContextMenuAction("ClipSlot", "Strudel: Edit & bake…", "strudelton.editSlot");
  context.ui.registerContextMenuAction("MidiClip", "Strudel: Edit & bake…", "strudelton.editClip");
  context.ui.registerContextMenuAction("MidiClip", "Strudel: Bake next window", "strudelton.bakeNext");

  console.log("[strudelton] activated — right-click a Session clip slot, or a MIDI clip.");
}

const clampBars = (n: number) => Math.max(1, Math.min(64, Math.round(n) || DEFAULT_BARS));

function asClipSlot(obj: DataModelObject<"1.0.0"> | null): ClipSlot<"1.0.0"> | null {
  return obj instanceof ClipSlot ? obj : null;
}
