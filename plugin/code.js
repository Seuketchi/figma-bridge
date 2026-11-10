// Runs in Figma's plugin sandbox. Receives jobs from ui.html (which holds the
// socket to the local bridge server), runs them and posts the answer back.
figma.showUI(__html__, { width: 260, height: 96, themeColors: true });

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const show = (v) => {
  if (v === undefined) return undefined;
  if (v && typeof v === "object" && "id" in v && "type" in v && "name" in v) return { id: v.id, type: v.type, name: v.name };
  try { return JSON.parse(JSON.stringify(v)); } catch (e) { return String(v); }
};

async function run(code) {
  const logs = [];
  const print = (...a) => logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(show(x)))).join(" "));
  const fn = new AsyncFunction("figma", "print", "console", code);
  const value = await fn(figma, print, { log: print, warn: print, error: print });
  return { value: show(value), logs };
}

async function shot({ nodeId, scale }) {
  const node = nodeId ? figma.getNodeById(nodeId) : figma.currentPage.selection[0] || figma.currentPage;
  if (!node) throw new Error(`no node ${nodeId}`);
  // A page cannot be exported, so with nothing selected the first top-level node is used.
  const n = node.type === "PAGE" ? node.children[0] : node;
  if (!n) throw new Error("the page is empty");
  const bytes = await n.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: scale || 1 } });
  return { bytes, node: { id: n.id, name: n.name, width: n.width, height: n.height } };
}

function info() {
  const sel = figma.currentPage.selection.map((n) => ({ id: n.id, type: n.type, name: n.name }));
  return {
    file: figma.root.name,
    page: { id: figma.currentPage.id, name: figma.currentPage.name },
    pages: figma.root.children.map((p) => ({ id: p.id, name: p.name })),
    selection: sel,
    top: figma.currentPage.children.slice(0, 200).map((n) => ({ id: n.id, type: n.type, name: n.name, x: Math.round(n.x), y: Math.round(n.y), w: Math.round(n.width), h: Math.round(n.height) })),
  };
}

figma.ui.onmessage = async (msg) => {
  const { id, kind } = msg;
  try {
    let result;
    if (kind === "run") result = await run(msg.code);
    else if (kind === "shot") result = await shot(msg);
    else if (kind === "info") result = info();
    else throw new Error(`unknown job ${kind}`);
    figma.ui.postMessage({ id, ok: true, result });
  } catch (e) {
    figma.ui.postMessage({ id, ok: false, error: String((e && e.stack) || e) });
  }
};
