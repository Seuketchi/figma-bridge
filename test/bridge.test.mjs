// End to end: client side (MCP over stdio) -> server -> WebSocket -> the real
// plugin/code.js, run in a vm against a stand-in `figma`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { setTimeout as wait } from "node:timers/promises";

const ROOT = new URL("..", import.meta.url).pathname;
const PORT = 3999;
const DIR = mkdtempSync(join(tmpdir(), "bridge-test-"));
let server, ws, seq = 0;
const answers = new Map();
let stdout = "";

function fakeFigma(post) {
  const node = (id, name, extra = {}) => ({ id, name, type: "FRAME", x: 0, y: 0, width: 100, height: 50, children: [], ...extra });
  const page = { id: "0:1", name: "Page 1", type: "PAGE", selection: [], children: [node("1:2", "Home", { exportAsync: async () => new Uint8Array([137, 80, 78, 71, 1, 2, 3]) })] };
  return {
    root: { name: "Sample file", children: [page] },
    currentPage: page,
    showUI() {},
    ui: { onmessage: null, postMessage: post },
    getNodeById: (id) => page.children.find((n) => n.id === id) || null,
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
  server = spawn(process.execPath, [join(ROOT, "server.mjs")], { env: { ...process.env, FIGMA_BRIDGE_PORT: PORT, FIGMA_BRIDGE_SHOTS: DIR } });
  server.stdout.on("data", (c) => {
    stdout += c;
    let nl;
    while ((nl = stdout.indexOf("\n")) >= 0) { const m = JSON.parse(stdout.slice(0, nl)); stdout = stdout.slice(nl + 1); answers.get(m.id)?.(m); }
  });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
});

after(() => { ws?.close(); server.kill(); rmSync(DIR, { recursive: true, force: true }); });

test("before the plugin connects, tools say how to open it", async () => {
  const r = await tool("figma_run", { code: "return 1" });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /Plugins > Development > MCP Bridge/);
});

test("lists its four tools", async () => {
  const r = await rpc("tools/list");
  assert.deepEqual(r.result.tools.map((t) => t.name), ["figma_status", "figma_run", "figma_run_file", "figma_screenshot"]);
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

  await t.test("a screenshot comes back as an image and a file", async () => {
    const r = await tool("figma_screenshot", { node_id: "1:2" });
    assert.equal(r.result.content[0].type, "image");
    const path = r.result.content[1].text.match(/saved to (.*)$/)[1];
    assert.ok(existsSync(path));
    assert.deepEqual([...readFileSync(path)], [137, 80, 78, 71, 1, 2, 3]);
  });
});
