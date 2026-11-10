#!/usr/bin/env node
// figma-bridge: an MCP server (stdio) that hands jobs to the MCP Bridge
// plugin running in Figma, over a WebSocket on localhost. No dependencies.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.FIGMA_BRIDGE_PORT || 3055);
const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = process.env.FIGMA_BRIDGE_SHOTS || join(HERE, "shots");
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
    description: "Run JavaScript in the open Figma file through the Plugin API, as the body of an async function with `figma` in scope (top-level await works). `print(...)` and `console.log(...)` are collected. Returns the value of a `return` statement, the printed lines, or the error with its stack. The plugin uses dynamic-page access: use figma.getNodeByIdAsync, figma.setCurrentPageAsync and page.loadAsync() before reading another page.",
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
