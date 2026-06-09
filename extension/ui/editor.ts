// Webview editor UI — runs in the modal's browser context (a real browser, where Strudel works
// fine). esbuild bundles this (browser/IIFE) and build.ts inlines it into dist/editor.html.
// Provides CodeMirror + a LIVE preview AND the bake itself — both run bake.mjs here in the webview,
// so the piano-roll shows exactly what will bake, and the Extension Host never runs Strudel (its
// permission sandbox forbids the temp files + child process a host-side bake would need).
import { EditorView, basicSetup } from "codemirror";
import { keymap } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";
import { evaluatePattern, bakeCycles, type BakedNote } from "../../src/bake.mjs";

interface Initial {
  code: string;
  bars: number;
}
// The extension passes the initial { code, bars } in the URL fragment (#<encoded JSON>), so the
// bundled editor.html needs no per-open injection — it stays a fixed, separate file.
function readInitial(): Initial {
  try {
    const frag = location.hash.replace(/^#/, "");
    if (frag) return JSON.parse(decodeURIComponent(frag)) as Initial;
  } catch {
    /* malformed fragment — fall through to the default */
  }
  return { code: "", bars: 4 };
}
const initial: Initial = readInitial();
const CFG = { beatsPerCycle: 4, defaultVelocity: 100 };

const w = window as unknown as {
  webkit?: { messageHandlers?: { live?: { postMessage(m: unknown): void } } };
  chrome?: { webview?: { postMessage(m: unknown): void } };
};
function send(message: unknown) {
  if (w.webkit?.messageHandlers?.live) w.webkit.messageHandlers.live.postMessage(message);
  else if (w.chrome?.webview) w.chrome.webview.postMessage(message);
}
const byId = (id: string) => document.getElementById(id) as HTMLElement;
const barsInput = () => byId("bars") as HTMLInputElement;
const currentBars = () => Math.max(1, Math.min(64, parseInt(barsInput().value, 10) || 1));

// Bake HERE in the webview and hand the NOTES back via close_and_send (the only way to close the
// dialog). The extension just writes them to the clip via the SDK — no child process, no temp file.
async function bake() {
  const code = view.state.doc.toString();
  const bars = currentBars();
  try {
    const { pattern } = await evaluatePattern(code);
    const { notes } = bakeCycles(pattern, 0, bars, CFG);
    send({ method: "close_and_send", params: [JSON.stringify({ code, bars, notes })] });
  } catch (e) {
    // Don't close on a broken pattern — surface the error and let the user fix it.
    const status = byId("status");
    status.textContent = "⚠ can't bake: " + ((e as Error)?.message ?? String(e)).split("\n")[0];
    status.className = "err";
  }
}
function cancel() {
  send({ method: "close_and_send", params: [JSON.stringify({ cancel: true })] });
}
// The cheat sheet: a reference of what bakes (and what's ignored / impossible), toggled from the
// header. It's a static panel in shell.html — this just shows/hides it.
function toggleHelp(show?: boolean) {
  const sheet = byId("cheatsheet");
  const next = show ?? sheet.hidden; // default: flip current state
  sheet.hidden = !next;
  byId("help").setAttribute("aria-expanded", String(next));
}

const view = new EditorView({
  doc: initial.code,
  parent: byId("editor"),
  extensions: [
    basicSetup,
    javascript(),
    oneDark,
    keymap.of([{ key: "Mod-Enter", run: () => (void bake(), true) }]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) schedulePreview();
    }),
    EditorView.theme({
      "&": { height: "100%", fontSize: "13px", backgroundColor: "#2b2b2b" },
      ".cm-scroller": { fontFamily: "ui-monospace, Menlo, monospace" },
    }),
  ],
});

// --- live preview --------------------------------------------------------------------------
let previewTimer = 0;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(runPreview, 180);
}

let previewSeq = 0;
async function runPreview() {
  const seq = ++previewSeq; // ignore stale results if the user keeps typing
  const code = view.state.doc.toString();
  const bars = currentBars();
  const status = byId("status");
  try {
    const { pattern } = await evaluatePattern(code);
    const { notes, skipped, ignoredControls } = bakeCycles(pattern, 0, bars, CFG);
    if (seq !== previewSeq) return;
    const chancy = notes.filter((n) => n.probability !== undefined).length;
    status.textContent =
      `${notes.length} note${notes.length === 1 ? "" : "s"} · ${bars} bar${bars === 1 ? "" : "s"}` +
      (chancy ? ` · ${chancy} chancy` : "") +
      (skipped ? ` · ${skipped} skipped` : "") +
      (ignoredControls.length ? `  ⚠ ignored: ${ignoredControls.join(", ")}` : "");
    status.className = ignoredControls.length ? "warn" : "ok";
    drawRoll(notes, bars);
  } catch (e) {
    if (seq !== previewSeq) return;
    status.textContent = "⚠ " + ((e as Error)?.message ?? String(e)).split("\n")[0];
    status.className = "err";
    clearRoll();
  }
}

function rollCtx(): { ctx: CanvasRenderingContext2D; W: number; H: number } {
  const canvas = byId("roll") as HTMLCanvasElement;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  const ctx = canvas.getContext("2d")!;
  return { ctx, W: canvas.width, H: canvas.height };
}
function clearRoll() {
  const { ctx, W, H } = rollCtx();
  ctx.clearRect(0, 0, W, H);
}
function drawRoll(notes: BakedNote[], bars: number) {
  const { ctx, W, H } = rollCtx();
  const dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, W, H);
  if (!notes.length) return;

  const totalBeats = bars * CFG.beatsPerCycle;
  let minP = Infinity;
  let maxP = -Infinity;
  for (const n of notes) {
    minP = Math.min(minP, n.pitch);
    maxP = Math.max(maxP, n.pitch);
  }
  const range = Math.max(1, maxP - minP);
  const padY = 4 * dpr;
  const noteH = 5 * dpr;
  const usableH = H - 2 * padY - noteH;

  // bar gridlines
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  for (let b = 0; b <= bars; b++) {
    const x = Math.round((b / bars) * W) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }

  for (const n of notes) {
    const x = (n.startTime / totalBeats) * W;
    const wpx = Math.max(2 * dpr, (n.duration / totalBeats) * W - 1);
    const y = padY + (1 - (n.pitch - minP) / range) * usableH;
    const vel = (n.velocity ?? 100) / 127;
    const prob = n.probability ?? 1;
    ctx.globalAlpha = 0.35 + 0.65 * prob; // chancy notes are dimmer
    ctx.fillStyle = `rgb(255, ${120 + Math.round(80 * vel)}, 0)`; // brighter with velocity
    ctx.fillRect(x, y, wpx, noteH);
  }
  ctx.globalAlpha = 1;
}

barsInput().value = String(initial.bars ?? 4);
byId("bake").addEventListener("click", bake);
byId("cancel").addEventListener("click", cancel);
byId("help").addEventListener("click", () => toggleHelp());
byId("help-close").addEventListener("click", () => toggleHelp(false));
barsInput().addEventListener("input", schedulePreview);
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  // Escape closes the cheat sheet if it's open; otherwise it cancels the dialog.
  if (!byId("cheatsheet").hidden) toggleHelp(false);
  else cancel();
});
window.addEventListener("resize", schedulePreview);
view.focus();
runPreview();
