// strudelton — Ableton Live extension (probe). Bakes a Strudel pattern into MIDI clips.
//
// Architecture (see ../../FINDINGS.md):
//   • The proposal's transport-driven "living window" is NOT buildable on Extensions SDK
//     1.0.0-beta.0 (no playhead/transport read, no persistent webview). This is the supported
//     alternative: an OFFLINE BAKE driven by context-menu commands + a modal editor.
//   • The installed (managed) Extension Host runs under Node's PERMISSION SANDBOX — no writing
//     temp files, no spawning a Node binary (`process.execPath` isn't one we can relaunch). So
//     Strudel runs ENTIRELY IN THE WEBVIEW (a real browser): the modal editor evaluates the
//     pattern AND bakes it, then returns the notes. This extension does no child_process and no
//     temp files — it loads the bundled editor.html as a data: URL (the SDK's documented webview
//     pattern), with the initial { code, bars } in the URL fragment, and writes the returned notes
//     to a clip via the SDK. editor.html is read at RUNTIME (not `import`-inlined like the SDK's own
//     example) so it stays a SEPARATE file — keeping Strudel (AGPL) out of the proprietary
//     extension.js preserves the license boundary (see ../../README.md#License).
//
// Commands:
//   • ClipSlot → "Strudel: Edit & bake…" — open the editor, bake N bars into a fresh clip.
//   • MidiClip → "Strudel: Edit & bake…" — reopen this clip's pattern, re-bake.

import {
  initialize,
  type ActivationContext,
  type DataModelObject,
  type Handle,
  type NoteDescription,
  ClipSlot,
  MidiClip,
} from "@ableton-extensions/sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const API_VERSION = "1.0.0";

// Showcases per-note velocity (accents) + probability (Live re-rolls each loop → evolving clip).
const DEFAULT_PATTERN =
  'note("c3 e3 g3 b3 a3 g3 e3 d3")\n' +
  '  .velocity("1 0.6 0.8 0.6 0.9 0.6 0.8 0.6")\n' +
  '  .prob("1 0.7 0.9 0.5 1 0.7 0.5 0.8")';
const DEFAULT_BARS = 4;
const CFG = { beatsPerCycle: 4, defaultVelocity: 100 };

// Per-clip pattern state, keyed by handle.id (bigint). Survives across command invocations because
// the Extension Host process stays alive — lets "edit this clip" reopen the pattern that made it.
const patterns = new Map<bigint, EditorState>();

interface EditorState {
  code: string;
  bars: number;
}
// What the webview returns from a bake: the edited pattern plus the notes it computed.
interface EditorResult extends EditorState {
  notes: NoteDescription[];
}

export function activate(activation: ActivationContext) {
  const context = initialize(activation, API_VERSION);

  // Build the modal URL. Documented SDK pattern (Essentials → Webviews): load the editor as a
  // data: URL, with the initial { code, bars } in the URL fragment. We read editor.html at runtime
  // (rather than `import`-inlining it) so it stays a SEPARATE bundled file — that keeps Strudel
  // (AGPL) out of the SDK's extension.js (proprietary). Reading our OWN bundled resource needs no
  // write permission; base64 keeps the encoding compact + predictable.
  function editorUrl(initial: EditorState): string {
    const frag = `#${encodeURIComponent(JSON.stringify(initial))}`;
    const path = join(__dirname, "editor.html");
    try {
      const html = readFileSync(path, "utf8");
      return `data:text/html;base64,${Buffer.from(html, "utf8").toString("base64")}${frag}`;
    } catch {
      // Reading our own install dir should be permitted; if some future sandbox denies it, fall
      // back to file:// (also a supported scheme) so the modal still opens.
      return `${pathToFileURL(path).href}${frag}`;
    }
  }

  // Open the modal editor seeded with `initial`; resolves to the baked result, or null if the user
  // dismissed it without baking.
  async function openEditor(initial: EditorState): Promise<EditorResult | null> {
    let result: string;
    try {
      result = await context.ui.showModalDialog(editorUrl(initial), 720, 560);
    } catch {
      return null; // dismissed / closed without baking
    }
    try {
      const parsed = JSON.parse(result) as Partial<EditorResult> & { cancel?: boolean };
      if (parsed.cancel || typeof parsed.code !== "string" || !Array.isArray(parsed.notes)) return null;
      return { code: parsed.code, bars: clampBars(parsed.bars ?? DEFAULT_BARS), notes: parsed.notes };
    } catch {
      return null;
    }
  }

  // Write the webview's baked notes into the slot as a fresh clip of the right length.
  async function bakeIntoSlot(slot: ClipSlot<"1.0.0">, result: EditorResult): Promise<void> {
    if (slot.clip) await slot.deleteClip(); // we control the clip length, so recreate
    const clip = await slot.createMidiClip(result.bars * CFG.beatsPerCycle);
    clip.notes = result.notes;
    patterns.set(clip.handle.id, { code: result.code, bars: result.bars });
    console.log(`[strudelton] baked ${result.bars} bar(s) -> ${result.notes.length} notes`);
  }

  // ClipSlot → edit & bake into a fresh clip.
  context.commands.registerCommand("strudelton.editSlot", async (arg: unknown) => {
    try {
      const slot = context.getObjectFromHandle(arg as Handle, ClipSlot);
      const existing = slot.clip instanceof MidiClip ? patterns.get(slot.clip.handle.id) : undefined;
      const edited = await openEditor(existing ?? { code: DEFAULT_PATTERN, bars: DEFAULT_BARS });
      if (edited) await bakeIntoSlot(slot, edited);
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
      if (edited) await bakeIntoSlot(slot, edited);
    } catch (e) {
      console.error("[strudelton] editClip failed:", e);
    }
  });

  context.ui.registerContextMenuAction("ClipSlot", "Strudel: Edit & bake…", "strudelton.editSlot");
  context.ui.registerContextMenuAction("MidiClip", "Strudel: Edit & bake…", "strudelton.editClip");

  console.log("[strudelton] activated — right-click a Session clip slot, or a MIDI clip.");
}

const clampBars = (n: number) => Math.max(1, Math.min(64, Math.round(n) || DEFAULT_BARS));

function asClipSlot(obj: DataModelObject<"1.0.0"> | null): ClipSlot<"1.0.0"> | null {
  return obj instanceof ClipSlot ? obj : null;
}
