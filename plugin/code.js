// Runs in Figma's plugin sandbox. Receives jobs from ui.html (which holds the
// socket to the local bridge server), runs them and posts the answer back.
figma.showUI(__html__, { width: 260, height: 96, themeColors: true });

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
// The plugin uses "dynamic-page" document access, so lookups are async.
const nodeById = async (id) => (figma.getNodeByIdAsync ? figma.getNodeByIdAsync(id) : figma.getNodeById(id));

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
  const node = nodeId ? await nodeById(nodeId) : figma.currentPage.selection[0] || figma.currentPage;
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

// ---------- read: a node tree as design data, for building it in code ----------

const r2 = (n) => Math.round(n * 100) / 100;
const hex = (c, o = 1) => {
  const h = (v) => Math.round(v * 255).toString(16).padStart(2, "0");
  const a = (c.a === undefined ? 1 : c.a) * o;
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${a < 1 ? h(a) : ""}`;
};

async function lookup(map, id, getAsync, getSync) {
  if (!id) return undefined;
  if (map.has(id)) return map.get(id);
  let item = null;
  try { item = getAsync ? await getAsync(id) : getSync(id); } catch (e) { item = null; }
  const name = item ? item.name : id;
  map.set(id, name);
  return name;
}

async function read({ nodeId, depth = 12, maxNodes = 1500 }) {
  const root = nodeId ? await nodeById(nodeId) : figma.currentPage.selection[0] || figma.currentPage.children[0];
  if (!root) throw new Error(nodeId ? `no node ${nodeId}` : "nothing selected and the page is empty");
  const vars = new Map(), styles = new Map(), used = { colors: {}, fonts: {}, variables: {}, styles: {} };
  const V = figma.variables || {};
  const varName = (id) => lookup(vars, id, V.getVariableByIdAsync && V.getVariableByIdAsync.bind(V), V.getVariableById && V.getVariableById.bind(V));
  const styleName = (id) => typeof id === "string" && id ? lookup(styles, id, figma.getStyleByIdAsync && figma.getStyleByIdAsync.bind(figma), figma.getStyleById && figma.getStyleById.bind(figma)) : undefined;
  let count = 0, truncated = false;

  async function paints(list, bound) {
    if (!Array.isArray(list)) return undefined; // figma.mixed
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (p.visible === false) continue;
      if (p.type === "SOLID") {
        const v = p.boundVariables && p.boundVariables.color ? await varName(p.boundVariables.color.id) : undefined;
        const c = hex(p.color, p.opacity === undefined ? 1 : p.opacity);
        used.colors[c] = (used.colors[c] || 0) + 1;
        if (v) used.variables[v] = c;
        out.push(v ? { color: c, variable: v } : c);
      } else if (p.type.startsWith("GRADIENT")) {
        out.push({ gradient: p.type.slice(9).toLowerCase(), stops: p.gradientStops.map((s) => `${hex(s.color)} ${Math.round(s.position * 100)}%`) });
      } else if (p.type === "IMAGE") {
        out.push({ image: p.imageHash, scale: p.scaleMode.toLowerCase() });
      } else out.push({ type: p.type.toLowerCase() });
    }
    return out.length ? out : undefined;
  }

  async function walk(n, parent, level) {
    if (count >= maxNodes) { truncated = true; return null; }
    if (n.visible === false) return null;
    count++;
    const o = { id: n.id, name: n.name, type: n.type.toLowerCase() };
    if ("width" in n) {
      const px = parent && "absoluteTransform" in parent ? parent.absoluteTransform[0][2] : 0, py = parent && "absoluteTransform" in parent ? parent.absoluteTransform[1][2] : 0;
      o.box = [r2(n.absoluteTransform[0][2] - px), r2(n.absoluteTransform[1][2] - py), r2(n.width), r2(n.height)];
    }
    if (n.rotation) o.rotation = r2(n.rotation);
    if ("opacity" in n && n.opacity < 1) o.opacity = r2(n.opacity);
    if (n.blendMode && !["NORMAL", "PASS_THROUGH"].includes(n.blendMode)) o.blend = n.blendMode.toLowerCase();

    // auto layout
    if (n.layoutMode && n.layoutMode !== "NONE") {
      o.layout = {
        dir: n.layoutMode === "HORIZONTAL" ? "row" : n.layoutMode === "VERTICAL" ? "column" : "grid",
        gap: n.itemSpacing, pad: [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft],
        main: n.primaryAxisAlignItems.toLowerCase(), cross: n.counterAxisAlignItems.toLowerCase(),
      };
      if (n.layoutWrap === "WRAP") o.layout.wrap = true, o.layout.rowGap = n.counterAxisSpacing;
    }
    if (parent && parent.layoutMode && parent.layoutMode !== "NONE") {
      if (n.layoutPositioning === "ABSOLUTE") o.absolute = true;
      const s = { h: n.layoutSizingHorizontal, v: n.layoutSizingVertical };
      if (s.h || s.v) o.sizing = `${(s.h || "").toLowerCase()} ${(s.v || "").toLowerCase()}`.trim();
    }
    if (n.constraints && parent && parent.type !== "PAGE" && !(parent.layoutMode && parent.layoutMode !== "NONE")) {
      const c = n.constraints;
      if (c.horizontal !== "MIN" || c.vertical !== "MIN") o.constraints = `${c.horizontal.toLowerCase()} ${c.vertical.toLowerCase()}`;
    }
    if (n.clipsContent) o.clips = true;

    // look
    if ("fills" in n && n.type !== "TEXT") { const f = await paints(n.fills); if (f) o.fills = f; }
    if ("fillStyleId" in n && n.type !== "TEXT") { const s = await styleName(n.fillStyleId); if (s) o.fillStyle = s, used.styles[s] = "fill"; }
    if ("strokes" in n && n.strokes.length) {
      const s = await paints(n.strokes);
      if (s) {
        o.stroke = { paints: s, weight: n.strokeWeight === figma.mixed ? [n.strokeTopWeight, n.strokeRightWeight, n.strokeBottomWeight, n.strokeLeftWeight] : n.strokeWeight, align: n.strokeAlign.toLowerCase() };
        if (n.dashPattern && n.dashPattern.length) o.stroke.dash = n.dashPattern;
      }
    }
    if ("cornerRadius" in n) {
      if (n.cornerRadius === figma.mixed) o.radius = [n.topLeftRadius, n.topRightRadius, n.bottomRightRadius, n.bottomLeftRadius];
      else if (n.cornerRadius) o.radius = n.cornerRadius;
    }
    if ("effects" in n && n.effects.length) {
      o.effects = n.effects.filter((e) => e.visible !== false).map((e) => e.type.includes("SHADOW")
        ? { [e.type === "INNER_SHADOW" ? "inset" : "shadow"]: `${r2(e.offset.x)} ${r2(e.offset.y)} ${r2(e.radius)} ${r2(e.spread || 0)} ${hex(e.color)}` }
        : { [e.type.toLowerCase()]: r2(e.radius) });
      const s = await styleName(n.effectStyleId); if (s) o.effectStyle = s;
    }
    if (n.boundVariables) {
      const b = {};
      for (const [k, v] of Object.entries(n.boundVariables)) {
        if (["fills", "strokes", "componentProperties"].includes(k)) continue;
        const one = Array.isArray(v) ? v[0] : v;
        if (one && one.id) { const name = await varName(one.id); b[k] = name; used.variables[name] = used.variables[name] || k; }
      }
      if (Object.keys(b).length) o.variables = b;
    }

    // text
    if (n.type === "TEXT") {
      o.text = n.characters;
      const segs = n.getStyledTextSegments(["fontName", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "textCase", "textDecoration", "fills", "textStyleId"]);
      const one = async (s) => {
        const t = { font: s.fontName.family, style: s.fontName.style, weight: s.fontWeight, size: s.fontSize };
        if (s.lineHeight.unit !== "AUTO") t.lineHeight = s.lineHeight.unit === "PIXELS" ? r2(s.lineHeight.value) : `${r2(s.lineHeight.value)}%`;
        if (s.letterSpacing.value) t.tracking = s.letterSpacing.unit === "PIXELS" ? r2(s.letterSpacing.value) : `${r2(s.letterSpacing.value)}%`;
        if (s.textCase !== "ORIGINAL") t.case = s.textCase.toLowerCase();
        if (s.textDecoration !== "NONE") t.decoration = s.textDecoration.toLowerCase();
        const f = await paints(s.fills); if (f) t.color = f.length === 1 ? f[0] : f;
        const st = await styleName(s.textStyleId); if (st) t.textStyle = st, used.styles[st] = "text";
        used.fonts[`${t.font} ${t.style}`] = (used.fonts[`${t.font} ${t.style}`] || 0) + 1;
        return t;
      };
      if (segs.length === 1) Object.assign(o, await one(segs[0]));
      else o.runs = await Promise.all(segs.map(async (s) => ({ text: s.characters, ...(await one(s)) })));
      o.align = n.textAlignHorizontal.toLowerCase();
      if (n.textAutoResize !== "NONE") o.autoResize = n.textAutoResize.toLowerCase();
    }

    // components
    if (n.type === "INSTANCE") {
      const main = n.getMainComponentAsync ? await n.getMainComponentAsync() : n.mainComponent;
      if (main) o.component = main.parent && main.parent.type === "COMPONENT_SET" ? `${main.parent.name} / ${main.name}` : main.name;
      if (n.componentProperties) {
        const p = {};
        for (const [k, v] of Object.entries(n.componentProperties)) p[k.split("#")[0]] = v.value;
        if (Object.keys(p).length) o.props = p;
      }
    }
    if (["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "LINE"].includes(n.type)) o.vector = true;

    if ("children" in n && n.type !== "INSTANCE" && level < depth) {
      const kids = [];
      for (const c of n.children) { const k = await walk(c, n, level + 1); if (k) kids.push(k); }
      if (kids.length) o.children = kids;
    } else if ("children" in n && n.children.length) o.childCount = n.children.length;
    return o;
  }

  const tree = await walk(root, root.parent, 0);
  const sortBy = (obj) => Object.fromEntries(Object.entries(obj).sort((a, b) => (typeof b[1] === "number" ? b[1] - a[1] : 0)));
  return { node: { id: root.id, name: root.name }, nodes: count, truncated, used: { colors: sortBy(used.colors), fonts: sortBy(used.fonts), variables: used.variables, styles: used.styles }, tree };
}

figma.ui.onmessage = async (msg) => {
  const { id, kind } = msg;
  try {
    let result;
    if (kind === "run") result = await run(msg.code);
    else if (kind === "shot") result = await shot(msg);
    else if (kind === "info") result = info();
    else if (kind === "read") result = await read(msg);
    else throw new Error(`unknown job ${kind}`);
    figma.ui.postMessage({ id, ok: true, result });
  } catch (e) {
    figma.ui.postMessage({ id, ok: false, error: String((e && e.stack) || e) });
  }
};
