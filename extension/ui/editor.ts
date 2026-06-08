// Webview editor UI — runs in the modal's browser context (NOT the extension/host). esbuild
// bundles this (browser/IIFE) and build.ts inlines it into dist/editor.html. CodeMirror lives
// here. The extension injects the initial { code, bars } as window.__strudeltonInitial.
import { EditorView, basicSetup } from "codemirror";
import { keymap } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";

interface Initial {
  code: string;
  bars: number;
}
const initial: Initial = (window as unknown as { __strudeltonInitial?: Initial }).__strudeltonInitial ?? {
  code: "",
  bars: 4,
};

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

// close_and_send is the only way the webview can close the dialog.
function bake() {
  const bars = Math.max(1, Math.min(64, parseInt(barsInput().value, 10) || 1));
  send({ method: "close_and_send", params: [JSON.stringify({ code: view.state.doc.toString(), bars })] });
}
function cancel() {
  send({ method: "close_and_send", params: [JSON.stringify({ cancel: true })] });
}

const view = new EditorView({
  doc: initial.code,
  parent: byId("editor"),
  extensions: [
    basicSetup,
    javascript(),
    oneDark,
    keymap.of([{ key: "Mod-Enter", run: () => (bake(), true) }]),
    EditorView.theme({
      "&": { height: "100%", fontSize: "13px", backgroundColor: "#2b2b2b" },
      ".cm-scroller": { fontFamily: "ui-monospace, Menlo, monospace" },
    }),
  ],
});

barsInput().value = String(initial.bars ?? 4);
byId("bake").addEventListener("click", bake);
byId("cancel").addEventListener("click", cancel);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") cancel();
});
view.focus();
