#!/usr/bin/env node
// figma-bridge: an MCP server (stdio) that hands jobs to the MCP Bridge
// plugin running in Figma, over a WebSocket on localhost. No dependencies.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.FIGMA_BRIDGE_PORT || 3055);
const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = process.env.FIGMA_BRIDGE_SHOTS || join(HERE, "shots");
const API = process.env.FIGMA_API_URL || "https://api.figma.com";
const TOKEN_FILE = join(homedir(), ".config", "figma-bridge", "token");
const log = (...a) => process.stderr.write(`[figma-bridge] ${a.join(" ")}\n`);

// ---------- WebSocket (RFC 6455, server side, text frames only) ----------

let socket = null; // the plugin's connection; the newest one wins
let listening = false;
const pending = new Map(); // job id -> { resolve, reject, timer }
let nextId = 1;

function frame(text) {
  const body = Buffer.from(text);
  const n = body.length;
  const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : Buffer.alloc(10);
  if (n >= 65536) { head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([head, body]);
}

function attach(sock) {
  let buf = Buffer.alloc(0);
  let parts = [];
  sock.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, at = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); at = 10; }
      const need = at + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let data = buf.subarray(at + (masked ? 4 : 0), need);
      if (masked) { const m = buf.subarray(at, at + 4); data = Buffer.from(data); for (let i = 0; i < data.length; i++) data[i] ^= m[i & 3]; }
      buf = buf.subarray(need);
      if (op === 8) { sock.end(Buffer.from([0x88, 0])); return; }
      if (op === 9) { sock.write(Buffer.concat([Buffer.from([0x8a, data.length]), data])); continue; }
      if (op === 1 || op === 0) { parts.push(data); if (fin) { onMessage(Buffer.concat(parts).toString()); parts = []; } }
    }
  });
  const drop = () => { if (socket === sock) { socket = null; log("plugin disconnected"); } };
  sock.on("close", drop);
  sock.on("error", drop);
}

function onMessage(text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  const job = pending.get(msg.id);
  if (!job) return;
  pending.delete(msg.id);
  clearTimeout(job.timer);
  msg.ok ? job.resolve(msg.result) : job.reject(new Error(msg.error));
}

const http = createServer((req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("figma-bridge is running.\n"); });
http.on("upgrade", (req, sock) => {
  // The plugin UI runs in a sandboxed iframe, whose origin is "null". Refuse web pages.
  const origin = req.headers.origin;
  if (origin && origin !== "null") { sock.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
  const key = req.headers["sec-websocket-key"];
  if (!key) { sock.end("HTTP/1.1 400 Bad Request\r\n\r\n"); return; }
  const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sock.setNoDelay(true);
  if (socket) socket.destroy();
  socket = sock;
  attach(sock);
  log("plugin connected");
});
http.on("error", (e) => {
  listening = false;
  if (e.code === "EADDRINUSE") { log(`port ${PORT} is held by another session; retrying`); setTimeout(listen, 5000).unref(); }
  else log(e.message);
});
function listen() { http.listen(PORT, "127.0.0.1", () => { listening = true; log(`listening on ${PORT}`); }); }
listen();

function send(job, timeoutMs = 120000) {
  if (!socket) {
    const why = listening
      ? "The MCP Bridge plugin is not connected. In Figma: Plugins > Development > MCP Bridge, and keep its window open."
      : `Port ${PORT} is held by another session; close that session's bridge or set FIGMA_BRIDGE_PORT.`;
    return Promise.reject(new Error(why));
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`no answer from Figma after ${timeoutMs / 1000}s`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    socket.write(frame(JSON.stringify({ id, ...job })));
  });
}

// ---------- MCP (JSON-RPC 2.0 over stdio, one message per line) ----------

const TOOLS = [
  {
    name: "figma_status",
    description: "Whether the MCP Bridge plugin is connected, and the open file: pages, current page, selection and its top-level nodes with their ids and bounds.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "figma_run",
    description: "Run JavaScript in the open Figma file through the Plugin API, as the body of an async function with `figma` in scope (top-level await works). `print(...)` and `console.log(...)` are collected. Returns the value of a `return` statement, the printed lines, or the error with its stack. The plugin uses dynamic-page access: use figma.getNodeByIdAsync, figma.setCurrentPageAsync and page.loadAsync() before reading another page. A layer whose fonts are missing cannot be moved into another parent or re-stacked (appendChild, insertChild), only moved by x and y.",
    inputSchema: { type: "object", properties: { code: { type: "string" }, timeout_s: { type: "number", description: "default 120" } }, required: ["code"] },
  },
  {
    name: "figma_run_file",
    description: "Run a JavaScript file from disk in Figma, the same way as figma_run. Use it for large generated scripts (such as Scripter scripts from the handoff tool) so they do not travel through the conversation.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, timeout_s: { type: "number", description: "default 300" } }, required: ["path"] },
  },
  {
    name: "figma_read",
    description: "Read a frame or node as design data for building it in code: the node tree with boxes relative to the parent, auto layout (direction, gap, padding, alignment, sizing), fills, strokes, radius, effects, text with font, weight, size, line height, tracking and colour (runs when mixed), component and variant props, and bound variables and styles by name. Also a summary of the colours, fonts, variables and styles used. With no node_id it reads the selection, else the first top-level node. Set screenshot to also see it.",
    inputSchema: { type: "object", properties: { node_id: { type: "string" }, depth: { type: "number", description: "levels to descend, default 12" }, max_nodes: { type: "number", description: "default 1500" }, screenshot: { type: "boolean" }, scale: { type: "number", description: "screenshot scale, default 1" } } },
  },
  {
    name: "figma_comments",
    description: "Read the comments on a Figma file as threads: who wrote each one, when, the text, whether it is resolved, the node it is pinned to (with the node's name when the plugin is open on that file) and the replies. The Plugin API cannot see comments, so this uses Figma's REST API with a personal access token from FIGMA_TOKEN or ~/.config/figma-bridge/token. With no file_key it uses the file open in the plugin.",
    inputSchema: { type: "object", properties: { file_key: { type: "string", description: "file key or figma.com URL; default: the open file" }, node_id: { type: "string", description: "only threads pinned to this node or inside it" }, unresolved: { type: "boolean", description: "only threads that are not resolved" } } },
  },
  {
    name: "figma_screenshot",
    description: "Export a node as PNG and show it. With no node_id it uses the first selected node, else the first top-level node of the page. The PNG is also saved to disk and its path returned.",
    inputSchema: { type: "object", properties: { node_id: { type: "string" }, scale: { type: "number", description: "default 1; keep the image under 8000 px a side" }, save_to: { type: "string" } } },
  },
];

const text = (t) => ({ content: [{ type: "text", text: typeof t === "string" ? t : JSON.stringify(t, null, 2) }] });

function runResult(r) {
  const out = [];
  if (r.logs?.length) out.push(r.logs.join("\n"));
  if (r.value !== undefined) out.push(JSON.stringify(r.value, null, 2));
  return text(out.join("\n\n") || "done (no return value)");
}

async function call(name, args = {}) {
  switch (name) {
    case "figma_status":
      if (!socket) return text({ connected: false, listening, port: PORT, help: "In Figma: Plugins > Development > MCP Bridge" });
      return text({ connected: true, ...(await send({ kind: "info" }, 15000)) });
    case "figma_run":
      return runResult(await send({ kind: "run", code: args.code }, (args.timeout_s || 120) * 1000));
    case "figma_run_file": {
      const code = readFileSync(resolve(args.path), "utf8");
      return runResult(await send({ kind: "run", code }, (args.timeout_s || 300) * 1000));
    }
    case "figma_read": {
      const r = await send({ kind: "read", nodeId: args.node_id, depth: args.depth, maxNodes: args.max_nodes }, 120000);
      const out = { content: [{ type: "text", text: JSON.stringify(r) }] };
      if (args.screenshot) {
        const shot = await call("figma_screenshot", { node_id: r.node.id, scale: args.scale });
        out.content.unshift(...shot.content);
      }
      return out;
    }
    case "figma_comments":
      return text(await comments(args));
    case "figma_screenshot": {
      const r = await send({ kind: "shot", nodeId: args.node_id, scale: args.scale || 1 }, 60000);
      const file = args.save_to ? resolve(args.save_to) : join(SHOTS, `${r.node.id.replace(/[^\w-]/g, "_")}-${Date.now()}.png`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, Buffer.from(r.png, "base64"));
      return { content: [{ type: "image", data: r.png, mimeType: "image/png" }, { type: "text", text: `${r.node.name} (${r.node.id}, ${Math.round(r.node.width)}×${Math.round(r.node.height)}) saved to ${file}` }] };
    }
    default:
      throw Object.assign(new Error(`unknown tool ${name}`), { code: -32602 });
  }
}

function token() {
  if (process.env.FIGMA_TOKEN) return process.env.FIGMA_TOKEN.trim();
  try { return readFileSync(TOKEN_FILE, "utf8").trim(); } catch { return ""; }
}

async function comments(args) {
  const tok = token();
  if (!tok) throw new Error(`Comments need a Figma personal access token with the file_comments:read scope (Figma > Settings > Security > Personal access tokens). Put it in ${TOKEN_FILE} or set FIGMA_TOKEN.`);
  let key = args.file_key?.match(/figma\.com\/(?:file|design|board|proto)\/([\w-]+)/)?.[1] || args.file_key;
  if (!key) {
    if (!socket) throw new Error("Give file_key, or open the MCP Bridge plugin in the file.");
    key = (await send({ kind: "info" }, 15000)).fileKey;
    if (!key) throw new Error("The plugin did not report the file key (reload the plugin after updating it), so give file_key.");
  }
  const res = await fetch(`${API}/v1/files/${encodeURIComponent(key)}/comments?as_md=true`, { headers: { "X-Figma-Token": tok } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Figma API ${res.status}: ${body.err || body.message || res.statusText}`);
  const list = body.comments || [];
  const nodeOf = (c) => c.client_meta?.node_id || null;
  const at = (c) => ({ id: c.id, by: c.user?.handle, at: c.created_at, text: c.message });
  let threads = list.filter((c) => !c.parent_id).map((c) => ({
    ...at(c), resolved: !!c.resolved_at, node: nodeOf(c),
    replies: list.filter((r) => r.parent_id === c.id).sort((a, b) => a.created_at.localeCompare(b.created_at)).map(at),
  }));
  if (args.unresolved) threads = threads.filter((t) => !t.resolved);
  // Node names, and which nodes sit inside node_id, come from the plugin when it is open on this file.
  const ids = [...new Set(threads.map((t) => t.node).filter(Boolean))];
  let names = {};
  if (socket && ids.length) {
    try {
      const code = `const out = {}; for (const id of ${JSON.stringify(ids)}) { const n = await figma.getNodeByIdAsync(id); if (!n) continue; const path = []; for (let p = n; p && p.type !== "DOCUMENT"; p = p.parent) path.push(p.id); out[id] = { name: n.name, path }; } return out;`;
      const r = await send({ kind: "run", code }, 30000);
      names = r.value || {};
    } catch { names = {}; }
  }
  if (args.node_id) threads = threads.filter((t) => t.node === args.node_id || names[t.node]?.path.includes(args.node_id));
  for (const t of threads) if (t.node) t.node = names[t.node] ? { id: t.node, name: names[t.node].name } : { id: t.node };
  threads.sort((a, b) => b.at.localeCompare(a.at));
  return { file: key, threads: threads.length, open: threads.filter((t) => !t.resolved).length, comments: threads };
}

const reply = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // a notification
  try {
    if (method === "initialize")
      return reply({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "figma-bridge", version: "0.1.0" } } });
    if (method === "ping") return reply({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") return reply({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    if (method === "tools/call") {
      try { return reply({ jsonrpc: "2.0", id, result: await call(params.name, params.arguments) }); }
      catch (e) { if (e.code === -32602) throw e; return reply({ jsonrpc: "2.0", id, result: { ...text(e.message), isError: true } }); }
    }
    reply({ jsonrpc: "2.0", id, error: { code: -32601, message: `no method ${method}` } });
  } catch (e) {
    reply({ jsonrpc: "2.0", id, error: { code: e.code || -32603, message: e.message } });
  }
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  let nl;
  while ((nl = input.indexOf("\n")) >= 0) {
    const line = input.slice(0, nl).trim();
    input = input.slice(nl + 1);
    if (line) { try { handle(JSON.parse(line)); } catch { reply({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); } }
  }
});
process.stdin.on("end", () => process.exit(0));
