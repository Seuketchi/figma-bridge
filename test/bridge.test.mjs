// End to end: client side (MCP over stdio) -> server -> WebSocket -> the real
// plugin/code.js, run in a vm against a stand-in `figma`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { createServer } from "node:http";
import { setTimeout as wait } from "node:timers/promises";

const ROOT = new URL("..", import.meta.url).pathname;
const PORT = 3999;
const DIR = mkdtempSync(join(tmpdir(), "bridge-test-"));
let server, ws, api, seq = 0;
const API_PORT = 3998;
const COMMENTS = [
  { id: "10", message: "Make the title **bigger**", user: { handle: "ana" }, created_at: "2026-11-10T09:00:00Z", resolved_at: null, client_meta: { node_id: "1:4", node_offset: { x: 1, y: 1 } } },
  { id: "11", parent_id: "10", message: "On it", user: { handle: "tan" }, created_at: "2026-11-10T10:00:00Z", resolved_at: null },
  { id: "12", message: "Old note", user: { handle: "ana" }, created_at: "2026-11-09T09:00:00Z", resolved_at: "2026-11-09T12:00:00Z", client_meta: { node_id: "1:2" } },
  { id: "13", message: "Loose pin on the canvas", user: { handle: "ben" }, created_at: "2026-11-11T09:00:00Z", resolved_at: null, client_meta: { x: 5, y: 5 } },
];
const answers = new Map();
let stdout = "";

function fakeFigma(post) {
  const node = (id, name, extra = {}) => ({ id, name, type: "FRAME", x: 0, y: 0, width: 100, height: 50, children: [], ...extra });
  const at = (x, y) => [[1, 0, x], [0, 1, y]];
  const text = node("1:4", "Title", {
    type: "TEXT", characters: "Hello", absoluteTransform: at(24, 24), textAlignHorizontal: "LEFT", textAutoResize: "WIDTH_AND_HEIGHT",
    getStyledTextSegments: () => [{ characters: "Hello", fontName: { family: "Fraunces", style: "Bold" }, fontWeight: 700, fontSize: 48, lineHeight: { unit: "PIXELS", value: 52 }, letterSpacing: { unit: "PERCENT", value: -2 }, textCase: "ORIGINAL", textDecoration: "NONE", fills: [{ type: "SOLID", color: { r: 0.0667, g: 0.0941, b: 0.1529 }, boundVariables: { color: { id: "v1" } } }], textStyleId: "s1" }],
  });
  const card = node("1:3", "Card", {
    absoluteTransform: at(0, 0), layoutMode: "VERTICAL", itemSpacing: 16, paddingTop: 24, paddingRight: 24, paddingBottom: 24, paddingLeft: 24,
    primaryAxisAlignItems: "MIN", counterAxisAlignItems: "CENTER", cornerRadius: 12,
    fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }], strokes: [], effects: [{ type: "DROP_SHADOW", visible: true, offset: { x: 0, y: 4 }, radius: 12, spread: 0, color: { r: 0, g: 0, b: 0, a: 0.25 } }],
    children: [text],
  });
  text.parent = card;
  const page = { id: "0:1", name: "Page 1", type: "PAGE", selection: [], children: [node("1:2", "Home", { exportAsync: async () => new Uint8Array([137, 80, 78, 71, 1, 2, 3]) }), card] };
  return {
    root: { name: "Sample file", children: [page] },
    fileKey: "KEY123",
    currentPage: page,
    showUI() {},
    ui: { onmessage: null, postMessage: post },
    getNodeByIdAsync: async (id) => [...page.children, text].find((n) => n.id === id) || null,
    getStyleByIdAsync: async (id) => ({ s1: { name: "Heading/XL" } })[id] || null,
    variables: { getVariableByIdAsync: async (id) => ({ v1: { name: "color/ink" } })[id] || null },
    mixed: Symbol("mixed"),
    createRectangle: () => { const r = node(`9:${page.children.length}`, "Rectangle", { type: "RECTANGLE" }); page.children.push(r); return r; },
  };
}

function rpc(method, params) {
  const id = ++seq;
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((res) => answers.set(id, res));
}
const tool = (name, args = {}) => rpc("tools/call", { name, arguments: args });

before(async () => {
  // A stand-in for Figma's REST API.
  api = createServer((req, res) => {
    const ok = req.headers["x-figma-token"] === "test-token" && req.url === "/v1/files/KEY123/comments?as_md=true";
    res.writeHead(ok ? 200 : 403, { "content-type": "application/json" });
    res.end(JSON.stringify(ok ? { comments: COMMENTS } : { status: 403, err: "Invalid token" }));
  }).listen(API_PORT, "127.0.0.1");
  server = spawn(process.execPath, [join(ROOT, "server.mjs")], { env: { ...process.env, FIGMA_BRIDGE_PORT: PORT, FIGMA_BRIDGE_SHOTS: DIR, FIGMA_API_URL: `http://127.0.0.1:${API_PORT}`, FIGMA_TOKEN: "test-token" } });
  server.stdout.on("data", (c) => {
    stdout += c;
    let nl;
    while ((nl = stdout.indexOf("\n")) >= 0) { const m = JSON.parse(stdout.slice(0, nl)); stdout = stdout.slice(nl + 1); answers.get(m.id)?.(m); }
  });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
});

after(() => { ws?.close(); server.kill(); api.close(); rmSync(DIR, { recursive: true, force: true }); });

test("before the plugin connects, tools say how to open it", async () => {
  const r = await tool("figma_run", { code: "return 1" });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /Plugins > Development > MCP Bridge/);
});

test("lists its tools", async () => {
  const r = await rpc("tools/list");
  assert.deepEqual(r.result.tools.map((t) => t.name), ["figma_status", "figma_run", "figma_run_file", "figma_read", "figma_comments", "figma_screenshot"]);
});

test("comments by file URL work without the plugin", async () => {
  const r = JSON.parse((await tool("figma_comments", { file_key: "https://www.figma.com/design/KEY123/Sample?node-id=1-2" })).result.content[0].text);
  assert.equal(r.file, "KEY123");
  assert.equal(r.threads, 3);
  assert.equal(r.open, 2);
  assert.deepEqual(r.comments.map((c) => c.id), ["13", "10", "12"]);
  assert.deepEqual(r.comments[1].replies, [{ id: "11", by: "tan", at: "2026-11-10T10:00:00Z", text: "On it" }]);
  assert.deepEqual(r.comments[1].node, { id: "1:4" });
  assert.equal(r.comments[0].node, null);
});

test("comments report a bad token and a missing file key", async () => {
  let r = await tool("figma_comments", { file_key: "OTHER" });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /Figma API 403: Invalid token/);
  r = await tool("figma_comments");
  assert.match(r.result.content[0].text, /Give file_key/);
});

test("a web page cannot connect", async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/`, { headers: { connection: "Upgrade", upgrade: "websocket", origin: "https://evil.example", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" } }).catch((e) => e);
  assert.ok(res instanceof Error || res.status === 403);
});

test("the plugin connects and runs jobs", async (t) => {
  // The plugin window: a socket that relays to code.js, as ui.html does.
  let figma;
  ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const post = (msg) => {
    if (msg.ok && msg.result?.bytes) { msg.result.png = Buffer.from(msg.result.bytes).toString("base64"); delete msg.result.bytes; }
    ws.send(JSON.stringify(msg));
  };
  figma = fakeFigma(post);
  vm.runInNewContext(readFileSync(join(ROOT, "plugin/code.js"), "utf8"), { figma, __html__: "", JSON, String, Object, Error, Math });
  ws.onmessage = (e) => figma.ui.onmessage(JSON.parse(e.data));
  await new Promise((r) => (ws.onopen = r));
  await wait(50);

  await t.test("status names the file and its nodes", async () => {
    const r = JSON.parse((await tool("figma_status")).result.content[0].text);
    assert.equal(r.connected, true);
    assert.equal(r.file, "Sample file");
    assert.equal(r.top[0].name, "Home");
  });

  await t.test("run returns values, printed lines and errors", async () => {
    let r = await tool("figma_run", { code: "print('hi', 2); const n = figma.createRectangle(); await null; return n" });
    assert.match(r.result.content[0].text, /hi 2/);
    assert.match(r.result.content[0].text, /"type": "RECTANGLE"/);
    r = await tool("figma_run", { code: "figma.nope()" });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /not a function/);
  });

  await t.test("a 3 MB script file goes through in one piece", async () => {
    const file = join(DIR, "big.js");
    writeFileSync(file, `const S = "${"x".repeat(3_000_000)}";\nreturn S.length`);
    const r = await tool("figma_run_file", { path: file });
    assert.equal(r.result.content[0].text, "3000000");
  });

  await t.test("read returns layout, look, text and the names of variables and styles", async () => {
    const r = JSON.parse((await tool("figma_read", { node_id: "1:3" })).result.content[0].text);
    assert.deepEqual(r.tree.layout, { dir: "column", gap: 16, pad: [24, 24, 24, 24], main: "min", cross: "center" });
    assert.deepEqual(r.tree.fills, ["#ffffff"]);
    assert.equal(r.tree.radius, 12);
    assert.deepEqual(r.tree.effects, [{ shadow: "0 4 12 0 #00000040" }]);
    const t = r.tree.children[0];
    assert.deepEqual(t.box, [24, 24, 100, 50]);
    assert.equal(t.text, "Hello");
    assert.equal(t.font, "Fraunces"); assert.equal(t.weight, 700); assert.equal(t.size, 48); assert.equal(t.lineHeight, 52); assert.equal(t.tracking, "-2%");
    assert.deepEqual(t.color, { color: "#111827", variable: "color/ink" });
    assert.equal(t.textStyle, "Heading/XL");
    assert.equal(r.used.variables["color/ink"], "#111827");
    assert.deepEqual(Object.keys(r.used.fonts), ["Fraunces Bold"]);
  });

  await t.test("comments use the open file, name their nodes and filter by node", async () => {
    let r = JSON.parse((await tool("figma_comments", { unresolved: true })).result.content[0].text);
    assert.equal(r.file, "KEY123");
    assert.deepEqual(r.comments.map((c) => c.id), ["13", "10"]);
    assert.deepEqual(r.comments[1].node, { id: "1:4", name: "Title" });
    r = JSON.parse((await tool("figma_comments", { node_id: "1:3" })).result.content[0].text);
    assert.deepEqual(r.comments.map((c) => c.id), ["10"]);
  });

  await t.test("a screenshot comes back as an image and a file", async () => {
    const r = await tool("figma_screenshot", { node_id: "1:2" });
    assert.equal(r.result.content[0].type, "image");
    const path = r.result.content[1].text.match(/saved to (.*)$/)[1];
    assert.ok(existsSync(path));
    assert.deepEqual([...readFileSync(path)], [137, 80, 78, 71, 1, 2, 3]);
  });
});
