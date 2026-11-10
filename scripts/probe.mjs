// Starts the bridge, waits up to 10 minutes for the plugin, then runs read-only
// checks: status, a tiny script that only reads, and a screenshot.
// Usage: node scripts/probe.mjs [node-id]
import { spawn } from "node:child_process";
const nodeId = process.argv[2];
const s = spawn(process.execPath, [new URL("../server.mjs", import.meta.url).pathname], { stdio: ["pipe", "pipe", "inherit"] });
let buf = "", seq = 0; const waits = new Map();
s.stdout.on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waits.get(m.id)?.(m); } });
const rpc = (method, params) => new Promise((r) => { const id = ++seq; waits.set(id, r); s.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
const tool = async (name, args = {}) => (await rpc("tools/call", { name, arguments: args })).result;
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "0" } });
let connected = false;
for (let i = 0; i < 600 && !connected; i++) {
  const st = JSON.parse((await tool("figma_status")).content[0].text);
  if (st.connected) { connected = true; console.log("STATUS", JSON.stringify({ file: st.file, page: st.page, pages: st.pages.length, selection: st.selection, top: st.top.length })); }
  else await new Promise((r) => setTimeout(r, 1000));
}
if (!connected) { console.log("the plugin never connected"); s.kill(); process.exit(1); }
const run = await tool("figma_run", { code: "print('scripts run'); return figma.currentPage.children.length" });
console.log("RUN", run.isError ? "ERROR " : "", run.content[0].text);
const shot = await tool("figma_screenshot", nodeId ? { node_id: nodeId, scale: 0.5 } : { scale: 0.5 });
console.log("SHOT", shot.isError ? "ERROR " + shot.content[0].text : shot.content[1].text);
s.kill(); process.exit(0);
