"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  app: () => app
});
module.exports = __toCommonJS(index_exports);
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
var import_node_os = require("node:os");
var import_node_child_process = require("node:child_process");
var import_node_crypto = require("node:crypto");
var import_node_http = require("node:http");
console.log("[VRM Manager] starting");
var { plugin, tool, s } = require("astra-plugin-sdk");
var ROOT = (0, import_node_path.join)(process.env.APPDATA || (0, import_node_path.join)((0, import_node_os.homedir)(), "AppData", "Roaming"), "Astra", "VRMManager");
var LIB = (0, import_node_path.join)(process.env.APPDATA || (0, import_node_path.join)((0, import_node_os.homedir)(), "AppData", "Roaming"), "astra", "astra", "config", "companion", "pack", "models");
var ACC = (0, import_node_path.join)(ROOT, "accessories");
var STATE = (0, import_node_path.join)(ROOT, "state.json");
var API = "https://hub.vroid.com";
var API_VERSION = "11";
var oauthState = "";
var oauthServer = null;
var state = {};
async function ensure() {
  await import_node_fs.promises.mkdir(LIB, { recursive: true });
  await import_node_fs.promises.mkdir(ACC, { recursive: true });
  try {
    state = JSON.parse(await import_node_fs.promises.readFile(STATE, "utf8"));
  } catch {
    state = {};
  }
}
async function saveState() {
  await import_node_fs.promises.mkdir(ROOT, { recursive: true });
  await import_node_fs.promises.writeFile(STATE, JSON.stringify(state, null, 2));
}
function ps(command) {
  return new Promise((resolve, reject) => {
    const p = (0, import_node_child_process.spawn)("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], { windowsHide: true });
    let o = "", e = "";
    p.stdout.on("data", (d) => o += d);
    p.stderr.on("data", (d) => e += d);
    p.on("close", (c) => c === 0 ? resolve(o.trim()) : reject(new Error(e || `PowerShell exit ${c}`)));
  });
}
async function openUrl(url) {
  await ps(`Start-Process -FilePath ${JSON.stringify(url)}`);
}
function authHeaders() {
  return { "X-Api-Version": API_VERSION, "Authorization": `Bearer ${state.accessToken}` };
}
async function refreshAccessToken() {
  if (!state.refreshToken || !state.clientId || !state.clientSecret) return false;
  const body = new URLSearchParams({ client_id: state.clientId, client_secret: state.clientSecret, grant_type: "refresh_token", refresh_token: state.refreshToken });
  const r = await fetch(API + "/oauth/token", { method: "POST", headers: { "X-Api-Version": API_VERSION, "Content-Type": "application/x-www-form-urlencoded" }, body });
  const text = await r.text();
  if (!r.ok) {
    state.accessToken = void 0;
    state.refreshToken = void 0;
    state.expiresAt = void 0;
    state.user = void 0;
    await saveState();
    return false;
  }
  const token = JSON.parse(text);
  state.accessToken = token.access_token;
  state.refreshToken = token.refresh_token || state.refreshToken;
  state.expiresAt = Date.now() + Math.max(60, Number(token.expires_in || 3600) - 120) * 1e3;
  await saveState();
  return true;
}
async function ensureAuth() {
  if (!state.accessToken && state.refreshToken) await refreshAccessToken();
  if (state.accessToken && state.expiresAt && Date.now() >= state.expiresAt) await refreshAccessToken();
  return Boolean(state.accessToken);
}
async function api(path, init = {}) {
  await ensureAuth();
  const doFetch = () => fetch(API + path, { ...init, headers: { ...authHeaders(), ...init.headers || {} } });
  let r = await doFetch();
  if (r.status === 401 && state.refreshToken) {
    if (await refreshAccessToken()) r = await doFetch();
  }
  const text = await r.text();
  if (!r.ok) throw new Error(`VRoid Hub ${r.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}
function b64url(b) {
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
async function beginOAuth(clientId, redirectUri, scope) {
  state.clientId = clientId;
  state.redirectUri = redirectUri;
  state.scope = scope;
  const verifier = b64url((0, import_node_crypto.randomBytes)(48));
  const challenge = b64url((0, import_node_crypto.createHash)("sha256").update(verifier).digest());
  oauthState = b64url((0, import_node_crypto.randomBytes)(24));
  await import_node_fs.promises.writeFile((0, import_node_path.join)(ROOT, "oauth.json"), JSON.stringify({ verifier, createdAt: Date.now() }));
  const u = new URL(API + "/oauth/authorize");
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("scope", scope);
  u.searchParams.set("state", oauthState);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  await openUrl(u.toString());
  return u.toString();
}
async function startOAuthCallback() {
  const port = 32198;
  if (oauthServer) return;
  oauthServer = (0, import_node_http.createServer)(async (req, res) => {
    try {
      const u = new URL(req.url || "/", `http://127.0.0.1:${port}`);
      if (u.pathname !== "/oauth/callback") {
        res.writeHead(404);
        res.end();
        return;
      }
      const code = u.searchParams.get("code") || "";
      const gotState = u.searchParams.get("state") || "";
      if (!code || !oauthState || gotState !== oauthState) throw new Error("OAuth state mismatch");
      const raw = JSON.parse(await import_node_fs.promises.readFile((0, import_node_path.join)(ROOT, "oauth.json"), "utf8"));
      const body = new URLSearchParams({ client_id: state.clientId || "", client_secret: state.clientSecret || "", redirect_uri: state.redirectUri || `http://127.0.0.1:${port}/oauth/callback`, grant_type: "authorization_code", code, code_verifier: raw.verifier });
      const tokenRes = await fetch(API + "/oauth/token", { method: "POST", headers: { "X-Api-Version": API_VERSION, "Content-Type": "application/x-www-form-urlencoded" }, body });
      const tokenText = await tokenRes.text();
      if (!tokenRes.ok) throw new Error(`Token exchange ${tokenRes.status}: ${tokenText.slice(0, 400)}`);
      const token = JSON.parse(tokenText);
      state.accessToken = token.access_token;
      state.refreshToken = token.refresh_token;
      state.expiresAt = Date.now() + Math.max(60, Number(token.expires_in || 3600) - 120) * 1e3;
      const profile = await api("/api/account");
      const udata = profile?.data?.user_detail?.user;
      state.user = udata ? { id: udata.id, name: udata.name, icon: udata.icon?.sq170?.url } : void 0;
      await saveState();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<html><body style="font-family:Segoe UI;background:#10131b;color:white;padding:40px"><h2>VRM Manager</h2><p>\u0412\u0445\u043E\u0434 \u0432 VRoid Hub \u0432\u044B\u043F\u043E\u043B\u043D\u0435\u043D. \u041C\u043E\u0436\u043D\u043E \u0437\u0430\u043A\u0440\u044B\u0442\u044C \u044D\u0442\u043E \u043E\u043A\u043D\u043E.</p><script>setTimeout(()=>window.close(),1200)</script></body></html>`);
    } catch (e) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<h3>VRM Manager: \u043E\u0448\u0438\u0431\u043A\u0430 \u0432\u0445\u043E\u0434\u0430</h3><pre>${String(e).replace(/[<>&]/g, "_")}</pre>`);
    }
  });
  await new Promise((resolve, reject) => oauthServer.listen(port, "127.0.0.1", () => resolve()));
}
async function extractThumbnail(filePath) {
  try {
    const { json, bin } = parseGlb(await import_node_fs.promises.readFile(filePath));
    const meta = json.extensions?.VRMC_vrm?.meta || json.extensions?.VRM?.meta || null;
    let imageIndex = meta?.thumbnailImage;
    if (imageIndex === void 0 && meta?.texture !== void 0) {
      const tex = json.textures?.[meta.texture];
      imageIndex = tex?.source;
    }
    const im = imageIndex !== void 0 ? json.images?.[imageIndex] : null;
    if (!im || !bin || im.bufferView === void 0) return null;
    const bv = json.bufferViews?.[im.bufferView];
    if (!bv) return null;
    const start = Number(bv.byteOffset || 0), end = start + Number(bv.byteLength || 0);
    const data = bin.subarray(start, end);
    if (!data.length || data.length > 4 * 1024 * 1024) return null;
    const mime = im.mimeType || (data[0] === 137 && data[1] === 80 ? "image/png" : data[0] === 255 && data[1] === 216 ? "image/jpeg" : null);
    return mime ? `data:${mime};base64,${data.toString("base64")}` : null;
  } catch {
    return null;
  }
}
async function walkVrmFiles(dir) {
  const out = [];
  try {
    for (const e of await import_node_fs.promises.readdir(dir, { withFileTypes: true })) {
      const p = (0, import_node_path.join)(dir, e.name);
      if (e.isDirectory()) {
        out.push(...await walkVrmFiles(p));
      } else if ((0, import_node_path.extname)(e.name).toLowerCase() === ".vrm") out.push(p);
    }
  } catch {
  }
  return out;
}
async function listModels() {
  const paths = await walkVrmFiles(LIB);
  const result = await Promise.all(paths.map(async (path) => {
    const st = await import_node_fs.promises.stat(path);
    let preview = state.recentMeta?.[path]?.preview;
    if (!preview) {
      preview = await extractThumbnail(path) || void 0;
      state.recentMeta = state.recentMeta || {};
      state.recentMeta[path] = { ...state.recentMeta[path] || {}, preview };
    }
    return { name: (0, import_node_path.basename)(path), path, size: st.size, modified: st.mtime.toISOString(), preview };
  }));
  await saveState();
  return result;
}
function parseGlb(buf) {
  if (buf.toString("ascii", 0, 4) !== "glTF") throw new Error("\u0424\u0430\u0439\u043B \u043D\u0435 \u043F\u043E\u0445\u043E\u0436 \u043D\u0430 GLB/VRM");
  const length = buf.readUInt32LE(8);
  let off = 12, json = null, bin = null;
  while (off + 8 <= Math.min(length, buf.length)) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4), chunk = buf.subarray(off + 8, off + 8 + len);
    if (type === 1313821514) json = JSON.parse(chunk.toString("utf8").replace(/\u0000+$/g, " ").trim());
    if (type === 5130562) bin = chunk;
    off += 8 + len;
  }
  if (!json) throw new Error("\u0412 GLB \u043E\u0442\u0441\u0443\u0442\u0441\u0442\u0432\u0443\u0435\u0442 JSON chunk");
  return { json, bin };
}
function buildGlb(json, bin) {
  const j = Buffer.from(JSON.stringify(json));
  const jp = Buffer.concat([j, Buffer.alloc((4 - j.length % 4) % 4, 32)]);
  const b = bin ? Buffer.concat([bin, Buffer.alloc((4 - bin.length % 4) % 4)]) : Buffer.alloc(0);
  const total = 12 + 8 + jp.length + (b.length ? 8 + b.length : 0);
  const out = Buffer.alloc(total);
  out.write("glTF", 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  let o = 12;
  out.writeUInt32LE(jp.length, o);
  out.writeUInt32LE(1313821514, o + 4);
  jp.copy(out, o + 8);
  o += 8 + jp.length;
  if (b.length) {
    out.writeUInt32LE(b.length, o);
    out.writeUInt32LE(5130562, o + 4);
    b.copy(out, o + 8);
  }
  return out;
}
function nodeLabel(n, i) {
  return n.name || `\u041E\u0431\u044A\u0435\u043A\u0442 ${i + 1}`;
}
function classifyNode(name, meshName = "") {
  const x = (name + " " + meshName).toLowerCase().replace(/[_\-.]+/g, " ");
  const has = (...w) => w.some((k) => x.includes(k));
  if (has("head", "skull", "face", "eye", "mouth", "nose", "ear", "jaw", "facial")) return "\u041B\u0438\u0446\u043E / \u0433\u043E\u043B\u043E\u0432\u0430";
  if (has("hair", "bang", "ponytail", "\u9AEA")) return "\u0412\u043E\u043B\u043E\u0441\u044B";
  if (has("shirt", "top", "jacket", "coat", "hoodie", "sweater", "blouse", "dress", "onepiece", "uniform", "upper", "chest", "torso", "clothes", "cloth")) return "\u0412\u0435\u0440\u0445\u043D\u044F\u044F \u043E\u0434\u0435\u0436\u0434\u0430";
  if (has("pants", "skirt", "shorts", "bottom", "trousers", "waist", "lower")) return "\u041D\u0438\u0436\u043D\u044F\u044F \u043E\u0434\u0435\u0436\u0434\u0430";
  if (has("shoe", "boot", "sandal", "foot", "sock")) return "\u041E\u0431\u0443\u0432\u044C";
  if (has("hand", "arm", "glove", "wrist")) return "\u0420\u0443\u043A\u0438";
  if (has("leg", "thigh", "knee", "calf")) return "\u041D\u043E\u0433\u0438";
  if (has("body", "skin", "bodymesh", "body mesh")) return "\u0422\u0435\u043B\u043E";
  if (has("accessory", "glasses", "hat", "cap", "horn", "wing", "tail", "ribbon", "jewel", "necklace", "earring", "bag", "weapon", "helmet")) return "\u0410\u043A\u0441\u0435\u0441\u0441\u0443\u0430\u0440";
  if (has("bone", "joint", "hips", "spine", "shoulder", "neck")) return "\u0421\u043A\u0435\u043B\u0435\u0442 / \u043A\u043E\u0441\u0442\u044C";
  return "\u041F\u0440\u043E\u0447\u0435\u0435";
}
function classifyNodes(json) {
  const nodes = Array.isArray(json.nodes) ? json.nodes : [];
  const meshes = Array.isArray(json.meshes) ? json.meshes : [];
  return nodes.map((n, i) => ({ index: i, name: nodeLabel(n, i), category: classifyNode(n.name || "", n.mesh != null && meshes[n.mesh] ? meshes[n.mesh].name || "" : ""), mesh: n.mesh ?? null, type: n.mesh != null ? "mesh" : "node", children: n.children || [], scale: n.scale || [1, 1, 1], hidden: n.extras?.astraHidden === true }));
}
async function inspectModel(filePath) {
  const buf = await import_node_fs.promises.readFile(filePath);
  const { json } = parseGlb(buf);
  return { path: filePath, name: (0, import_node_path.basename)(filePath), nodes: classifyNodes(json), meshes: (json.meshes || []).map((m, i) => ({ index: i, name: m.name || `Mesh ${i + 1}`, primitives: (m.primitives || []).length })), extensions: Object.keys(json.extensionsUsed || {}), categories: [...new Set(classifyNodes(json).map((n) => n.category))] };
}
async function setNodeVisible(filePath, index, visible) {
  const buf = await import_node_fs.promises.readFile(filePath);
  const p = parseGlb(buf);
  if (!p.json.nodes?.[index]) throw new Error("\u041E\u0431\u044A\u0435\u043A\u0442 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D");
  p.json.nodes[index].scale = visible ? [1, 1, 1] : [0, 0, 0];
  p.json.nodes[index].extras = { ...p.json.nodes[index].extras || {}, astraHidden: !visible };
  const out = filePath.replace(/\.vrm$/i, ".edited.vrm");
  await import_node_fs.promises.writeFile(out, buildGlb(p.json, p.bin));
  return out;
}
async function listAccessories() {
  const files = await import_node_fs.promises.readdir(ACC);
  return Promise.all(files.filter((f) => [".glb", ".vrm"].includes((0, import_node_path.extname)(f).toLowerCase())).map(async (f) => {
    const st = await import_node_fs.promises.stat((0, import_node_path.join)(ACC, f));
    return { name: f, path: (0, import_node_path.join)(ACC, f), size: st.size, modified: st.mtime.toISOString() };
  }));
}
async function mergeAccessory(modelPath, accessoryPath, boneIndex) {
  const base = parseGlb(await import_node_fs.promises.readFile(modelPath));
  const acc = parseGlb(await import_node_fs.promises.readFile(accessoryPath));
  if (!acc.json.meshes?.length) throw new Error("\u0410\u043A\u0441\u0435\u0441\u0441\u0443\u0430\u0440 \u043D\u0435 \u0441\u043E\u0434\u0435\u0440\u0436\u0438\u0442 mesh. \u041D\u0443\u0436\u0435\u043D GLB/VRM \u0441 \u0433\u0435\u043E\u043C\u0435\u0442\u0440\u0438\u0435\u0439.");
  if (!base.json.nodes?.[boneIndex]) throw new Error("\u041A\u043E\u0441\u0442\u044C/\u0443\u0437\u0435\u043B \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D.");
  const b = base.json, a = acc.json;
  const arr = (x, k) => Array.isArray(x?.[k]) ? x[k] : [];
  const baseBin = base.bin || Buffer.alloc(0), accBin = acc.bin || Buffer.alloc(0);
  const pad = (n) => (4 - n % 4) % 4;
  const binOffset = baseBin.length + pad(baseBin.length);
  const mergedBin = Buffer.concat([baseBin, Buffer.alloc(pad(baseBin.length)), accBin]);
  const bvs = arr(a, "bufferViews");
  const accs = arr(a, "accessors");
  const meshes = arr(a, "meshes");
  const mats = arr(a, "materials");
  const tex = arr(a, "textures");
  const imgs = arr(a, "images");
  const sam = arr(a, "samplers");
  const nodes = arr(a, "nodes");
  const skins = arr(a, "skins");
  const anims = arr(a, "animations");
  const bvBase = arr(b, "bufferViews").length, accBase = arr(b, "accessors").length, meshBase = arr(b, "meshes").length, matBase = arr(b, "materials").length, texBase = arr(b, "textures").length, imgBase = arr(b, "images").length, samBase = arr(b, "samplers").length, nodeBase = arr(b, "nodes").length, skinBase = arr(b, "skins").length;
  for (const v of bvs) {
    if (v.buffer === void 0) v.buffer = 0;
    v.buffer = 0;
    v.byteOffset = (v.byteOffset || 0) + binOffset;
  }
  for (const x of accs) {
    if (x.bufferView !== void 0) x.bufferView += bvBase;
  }
  for (const m of meshes) {
    for (const pr of m.primitives || []) {
      if (pr.indices !== void 0) pr.indices += accBase;
      if (pr.attributes) for (const k of Object.keys(pr.attributes)) pr.attributes[k] += accBase;
      if (pr.targets) for (const t of pr.targets) for (const k of Object.keys(t)) t[k] += accBase;
      if (pr.material !== void 0) pr.material += matBase;
    }
  }
  for (const im of imgs) {
    if (im.bufferView !== void 0) im.bufferView += bvBase;
  }
  for (const t of tex) {
    if (t.sampler !== void 0) t.sampler += samBase;
    if (t.source !== void 0) t.source += imgBase;
  }
  for (const sk of skins) {
    if (sk.inverseBindMatrices !== void 0) sk.inverseBindMatrices += accBase;
    if (sk.skeleton !== void 0) sk.skeleton += nodeBase;
    if (sk.joints) sk.joints = sk.joints.map((i) => i + nodeBase);
  }
  for (const n of nodes) {
    if (n.mesh !== void 0) n.mesh += meshBase;
    if (n.skin !== void 0) n.skin += skinBase;
    if (n.children) n.children = n.children.map((i) => i + nodeBase);
  }
  for (const an of anims) {
    for (const ch of an.channels || []) {
      if (ch.target?.node !== void 0) ch.target.node += nodeBase;
    }
  }
  if (imgs.some((im) => typeof im.uri === "string" && !im.uri.startsWith("data:"))) throw new Error("\u0410\u043A\u0441\u0435\u0441\u0441\u0443\u0430\u0440 \u0441\u043E\u0434\u0435\u0440\u0436\u0438\u0442 \u0432\u043D\u0435\u0448\u043D\u0438\u0435 \u0438\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u044F. \u042D\u043A\u0441\u043F\u043E\u0440\u0442\u0438\u0440\u0443\u0439 \u0435\u0433\u043E \u043A\u0430\u043A GLB \u0441 \u0432\u0441\u0442\u0440\u043E\u0435\u043D\u043D\u044B\u043C\u0438 \u0442\u0435\u043A\u0441\u0442\u0443\u0440\u0430\u043C\u0438.");
  const roots = [];
  const scene = a.scenes?.[a.scene || 0];
  if (scene?.nodes?.length) roots.push(...scene.nodes.map((i) => i + nodeBase));
  else nodes.forEach((n, i) => {
    if (!nodes.some((q) => q.children?.includes(i))) roots.push(i + nodeBase);
  });
  const bone = b.nodes[boneIndex];
  bone.children = [...bone.children || [], ...roots];
  b.bufferViews = [...arr(b, "bufferViews"), ...bvs];
  b.accessors = [...arr(b, "accessors"), ...accs];
  b.samplers = [...arr(b, "samplers"), ...sam];
  b.images = [...arr(b, "images"), ...imgs];
  b.textures = [...arr(b, "textures"), ...tex];
  b.materials = [...arr(b, "materials"), ...mats];
  b.meshes = [...arr(b, "meshes"), ...meshes];
  b.nodes = [...arr(b, "nodes"), ...nodes];
  if (skins.length) b.skins = [...arr(b, "skins"), ...skins];
  if (anims.length) b.animations = [...arr(b, "animations"), ...anims];
  b.scenes = arr(b, "scenes");
  if (!b.scenes.length) b.scenes = [{ nodes: [] }];
  b.buffers = [{ byteLength: mergedBin.length }];
  const out = modelPath.replace(/\.vrm$/i, ".with-accessories.vrm");
  await import_node_fs.promises.writeFile(out, buildGlb(b, mergedBin));
  return out;
}
async function getModelData(path) {
  const buf = await import_node_fs.promises.readFile(path);
  if (buf.length > 120 * 1024 * 1024) throw new Error("\u041C\u043E\u0434\u0435\u043B\u044C \u0441\u043B\u0438\u0448\u043A\u043E\u043C \u0431\u043E\u043B\u044C\u0448\u0430\u044F \u0434\u043B\u044F \u0432\u0441\u0442\u0440\u043E\u0435\u043D\u043D\u043E\u0433\u043E \u043F\u0440\u0435\u0434\u043F\u0440\u043E\u0441\u043C\u043E\u0442\u0440\u0430 (>120 \u041C\u0411).");
  return { name: (0, import_node_path.basename)(path), base64: buf.toString("base64") };
}
async function importAccessory(path) {
  const ext = (0, import_node_path.extname)(path).toLowerCase();
  if (![".glb", ".vrm"].includes(ext)) throw new Error("\u041F\u043E\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u044E\u0442\u0441\u044F GLB \u0438 VRM.");
  const dst = (0, import_node_path.join)(ACC, (0, import_node_path.basename)(path));
  await import_node_fs.promises.copyFile(path, dst);
  return { path: dst };
}
async function searchAccessories(keyword) {
  if (!await ensureAuth()) throw new Error("\u0421\u043D\u0430\u0447\u0430\u043B\u0430 \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0438\u0442\u0435 VRoid Hub.");
  const q = new URLSearchParams({ keyword: keyword.trim(), count: "50", sort: "_score", has_booth_items: "true" });
  q.append("booth_part_categories[]", "accessory");
  const result = await api(`/api/search/character_models?${q.toString()}`);
  const models = Array.isArray(result?.data) ? result.data : [];
  const items = [];
  const seen = /* @__PURE__ */ new Set();
  for (const m of models) {
    for (const x of m.character_model_booth_items || []) {
      const id = String(x.booth_item_id || "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      items.push({ id, partCategory: x.part_category || "accessory", modelId: m.id, modelName: m.name || m.id, preview: m.portrait_image?.sq300?.url || m.portrait_image?.w300?.url || null, boothUrl: `https://booth.pm/items/${encodeURIComponent(id)}` });
    }
  }
  return { ok: true, data: items.slice(0, 100), count: Math.min(items.length, 100), modelsFound: models.length };
}
function base32Id(bytes) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) out += alphabet[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}
async function findCompanionRoot() {
  const appdata = process.env.APPDATA || (0, import_node_path.join)((0, import_node_os.homedir)(), "AppData", "Roaming");
  const localappdata = process.env.LOCALAPPDATA || (0, import_node_path.join)((0, import_node_os.homedir)(), "AppData", "Local");
  const explicit = (process.env.ASTRA_COMPANION_DIR || "").trim();
  const candidates = [];
  const add = (p) => {
    if (p && !candidates.includes(p)) candidates.push(p);
  };
  if (explicit) add(explicit);
  for (const root of [appdata, localappdata]) {
    for (const name of ["astra", "Astra"]) {
      add((0, import_node_path.join)(root, name, "astra", "config", "companion"));
      add((0, import_node_path.join)(root, name, "config", "companion"));
      add((0, import_node_path.join)(root, name, "config", "companion", "pack"));
    }
  }
  const looksLikeCompanion = async (p) => {
    try {
      const st = await import_node_fs.promises.stat(p);
      if (!st.isDirectory()) return false;
      const lib = (0, import_node_path.join)(p, "library.json"), models = (0, import_node_path.join)(p, "pack", "models"), chars = (0, import_node_path.join)(p, "pack", "characters");
      const [a, b, c] = await Promise.all([import_node_fs.promises.stat(lib), import_node_fs.promises.stat(models), import_node_fs.promises.stat(chars)]);
      return a.isFile() && b.isDirectory() && c.isDirectory();
    } catch {
      return false;
    }
  };
  for (const p of candidates) {
    if (await looksLikeCompanion(p)) return p;
  }
  const roots = [(0, import_node_path.join)(appdata, "astra"), (0, import_node_path.join)(appdata, "Astra"), (0, import_node_path.join)(localappdata, "astra"), (0, import_node_path.join)(localappdata, "Astra")];
  const queue = roots.map((p) => ({ p, d: 0 }));
  const seen = /* @__PURE__ */ new Set();
  while (queue.length) {
    const { p, d } = queue.shift();
    const key = p.toLowerCase();
    if (seen.has(key) || d > 6) continue;
    seen.add(key);
    if (await looksLikeCompanion(p)) return p;
    try {
      const entries = await import_node_fs.promises.readdir(p, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith(".")) continue;
        if (["node_modules", "cache", "caches", "logs", "temp", "tmp"].includes(e.name.toLowerCase())) continue;
        queue.push({ p: (0, import_node_path.join)(p, e.name), d: d + 1 });
      }
    } catch {
    }
  }
  throw new Error("\u041D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D \u043A\u0430\u0442\u0430\u043B\u043E\u0433 Astra Character Library. \u041F\u043B\u0430\u0433\u0438\u043D \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u0438 \u043F\u0440\u043E\u0432\u0435\u0440\u0438\u043B \u0441\u0442\u0430\u043D\u0434\u0430\u0440\u0442\u043D\u044B\u0435 \u043A\u0430\u0442\u0430\u043B\u043E\u0433\u0438 AppData \u0438 Astra. \u0415\u0441\u043B\u0438 Astra \u0443\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u0430 \u0432 \u043D\u0435\u0441\u0442\u0430\u043D\u0434\u0430\u0440\u0442\u043D\u043E\u0439 \u043A\u043E\u043D\u0444\u0438\u0433\u0443\u0440\u0430\u0446\u0438\u0438, \u0437\u0430\u0434\u0430\u0439\u0442\u0435 \u043F\u0435\u0440\u0435\u043C\u0435\u043D\u043D\u0443\u044E ASTRA_COMPANION_DIR.");
}
async function atomicWrite(path, data) {
  const tmp = path + `.vrm-manager-${process.pid}-${Date.now()}.tmp`;
  await import_node_fs.promises.writeFile(tmp, data, "utf8");
  let last;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await import_node_fs.promises.rename(tmp, path);
      return;
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    }
  }
  try {
    await import_node_fs.promises.rm(tmp, { force: true });
  } catch {
  }
  throw last || new Error("\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043E\u0431\u043D\u043E\u0432\u0438\u0442\u044C library.json.");
}
function cloneJson(x) {
  return JSON.parse(JSON.stringify(x));
}
async function installToAstraLibrary(filePath) {
  const src = String(filePath || "");
  if (!src) throw new Error("\u041D\u0435 \u0443\u043A\u0430\u0437\u0430\u043D \u043F\u0443\u0442\u044C \u043A VRM.");
  if ((0, import_node_path.extname)(src).toLowerCase() !== ".vrm") throw new Error("\u0412 Character Library Astra \u043C\u043E\u0436\u043D\u043E \u0438\u043C\u043F\u043E\u0440\u0442\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u0442\u043E\u043B\u044C\u043A\u043E .vrm.");
  await import_node_fs.promises.access(src);
  const companion = await findCompanionRoot();
  const modelsDir = (0, import_node_path.join)(companion, "pack", "models");
  const charsDir = (0, import_node_path.join)(companion, "pack", "characters");
  const libraryPath = (0, import_node_path.join)(companion, "library.json");
  await import_node_fs.promises.mkdir(modelsDir, { recursive: true });
  await import_node_fs.promises.mkdir(charsDir, { recursive: true });
  let library = { characters: [] };
  try {
    library = JSON.parse(await import_node_fs.promises.readFile(libraryPath, "utf8"));
  } catch {
  }
  if (!library || typeof library !== "object" || Array.isArray(library)) library = { characters: [] };
  if (!Array.isArray(library.characters)) library.characters = [];
  const sourceStat = await import_node_fs.promises.stat(src);
  let modelId = "";
  let modelDst = "";
  for (let attempt = 0; attempt < 20; attempt++) {
    modelId = base32Id((0, import_node_crypto.randomBytes)(20));
    modelDst = (0, import_node_path.join)(modelsDir, modelId + ".vrm");
    try {
      await import_node_fs.promises.access(modelDst);
    } catch {
      break;
    }
  }
  if (!modelId || !modelDst) throw new Error("\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0432\u044B\u0431\u0440\u0430\u0442\u044C \u0443\u043D\u0438\u043A\u0430\u043B\u044C\u043D\u043E\u0435 \u0438\u043C\u044F VRM-\u043C\u043E\u0434\u0435\u043B\u0438.");
  let charId = modelId.toLowerCase();
  let charDir = (0, import_node_path.join)(charsDir, charId);
  let n = 1;
  while (true) {
    try {
      await import_node_fs.promises.access(charDir);
      n++;
      charDir = (0, import_node_path.join)(charsDir, `${modelId.toLowerCase()}-${n}`);
    } catch {
      break;
    }
  }
  const charToml = (0, import_node_path.join)(charDir, "character.toml");
  let template = null;
  for (const c of library.characters) {
    if (c && c.kind === "vrm") {
      template = cloneJson(c);
      break;
    }
  }
  if (!template) {
    template = { kind: "vrm", dir: charDir, model: { ref: `models/${modelId}.vrm` } };
  } else {
    template.dir = charDir;
    if (template.model && typeof template.model === "object") template.model.ref = `models/${modelId}.vrm`;
    if (template.ref !== void 0) template.ref = `models/${modelId}.vrm`;
    if (template.model !== void 0 && typeof template.model === "string") template.model = `models/${modelId}.vrm`;
    if (template.id !== void 0) template.id = charId;
    if (template.character_id !== void 0) template.character_id = charId;
    if (template.uuid !== void 0) template.uuid = modelId;
  }
  const toml = [
    "# This file is YOURS: edit it freely, or delete the character to remove it.",
    "# The body is REFERENCED through `model` below rather than copied.",
    "",
    "[character]",
    'kind = "vrm"',
    `model = "models/${modelId}.vrm"`,
    ""
  ].join("\\n");
  await import_node_fs.promises.mkdir(charDir, { recursive: true });
  try {
    await import_node_fs.promises.copyFile(src, modelDst);
    await import_node_fs.promises.writeFile(charToml, toml, "utf8");
    library.characters.push(template);
    const backup = libraryPath + `.bak-${Date.now()}`;
    try {
      await import_node_fs.promises.copyFile(libraryPath, backup);
    } catch {
    }
    await atomicWrite(libraryPath, JSON.stringify(library, null, 2));
  } catch (e) {
    try {
      await import_node_fs.promises.rm(charDir, { recursive: true, force: true });
    } catch {
    }
    try {
      await import_node_fs.promises.rm(modelDst, { force: true });
    } catch {
    }
    throw e;
  }
  await new Promise((r) => setTimeout(r, 700));
  return { ok: true, path: modelDst, characterDir: charDir, characterId: charId, modelId, sourceSize: sourceStat.size, message: `VRM \u0434\u043E\u0431\u0430\u0432\u043B\u0435\u043D \u0432 Character Library Astra. \u041D\u0430\u0439\u0434\u0435\u043D\u043E \u0445\u0440\u0430\u043D\u0438\u043B\u0438\u0449\u0435: ${companion}. \u041E\u0442\u043A\u0440\u043E\u0439\u0442\u0435 \u0431\u0438\u0431\u043B\u0438\u043E\u0442\u0435\u043A\u0443 \u043F\u0435\u0440\u0441\u043E\u043D\u0430\u0436\u0435\u0439 \u0438\u043B\u0438 \u043F\u0435\u0440\u0435\u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u0435 Astra, \u0435\u0441\u043B\u0438 \u0441\u043F\u0438\u0441\u043E\u043A \u0435\u0449\u0451 \u043D\u0435 \u043E\u0431\u043D\u043E\u0432\u0438\u043B\u0441\u044F.` };
}
var app = plugin({
  id: "denchik-vroid-manager",
  tools: {
    vrm_library: tool({ description: "\u041F\u043E\u043A\u0430\u0437\u044B\u0432\u0430\u0435\u0442 \u043B\u043E\u043A\u0430\u043B\u044C\u043D\u0443\u044E \u0431\u0438\u0431\u043B\u0438\u043E\u0442\u0435\u043A\u0443 VRM.", input: s.object({}), run: async () => JSON.stringify(await listModels()) }),
    vrm_search: tool({ description: "\u0418\u0449\u0435\u0442 \u043C\u043E\u0434\u0435\u043B\u0438 \u0432 VRoid Hub.", input: s.object({ keyword: s.string({ minLength: 1 }), downloadable: s.boolean().optional() }), run: async ({ keyword, downloadable }) => {
      if (!await ensureAuth()) return "\u041D\u0435 \u0432\u044B\u043F\u043E\u043B\u043D\u0435\u043D \u0432\u0445\u043E\u0434 \u0432 VRoid Hub. \u041E\u0442\u043A\u0440\u043E\u0439\u0442\u0435 VRoid Hub \u0438 \u0432\u044B\u043F\u043E\u043B\u043D\u0438\u0442\u0435 \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u0435.";
      const q = new URLSearchParams({ keyword, count: "20", is_downloadable: String(downloadable ?? true) });
      return JSON.stringify(await api(`/api/search/character_models?${q}`));
    } }),
    vrm_model_info: tool({ description: "\u041F\u043E\u043A\u0430\u0437\u044B\u0432\u0430\u0435\u0442 \u0441\u043E\u0441\u0442\u0430\u0432 VRM: nodes, meshes \u0438 extensions.", input: s.object({ path: s.string() }), run: async ({ path }) => JSON.stringify(await inspectModel(path)) }),
    vrm_hide_element: tool({ description: "\u0421\u043E\u0437\u0434\u0430\u0451\u0442 \u043A\u043E\u043F\u0438\u044E VRM \u0438 \u0441\u043A\u0440\u044B\u0432\u0430\u0435\u0442 node \u043F\u043E \u0438\u043D\u0434\u0435\u043A\u0441\u0443.", input: s.object({ path: s.string(), nodeIndex: s.integer({ minimum: 0 }) }), run: async ({ path, nodeIndex }) => setNodeVisible(path, nodeIndex, false) }),
    vrm_show_element: tool({ description: "\u0421\u043E\u0437\u0434\u0430\u0451\u0442 \u043A\u043E\u043F\u0438\u044E VRM \u0438 \u043F\u043E\u043A\u0430\u0437\u044B\u0432\u0430\u0435\u0442 node \u043F\u043E \u0438\u043D\u0434\u0435\u043A\u0441\u0443.", input: s.object({ path: s.string(), nodeIndex: s.integer({ minimum: 0 }) }), run: async ({ path, nodeIndex }) => setNodeVisible(path, nodeIndex, true) }),
    vrm_accessories: tool({ description: "\u041F\u043E\u043A\u0430\u0437\u044B\u0432\u0430\u0435\u0442 \u043B\u043E\u043A\u0430\u043B\u044C\u043D\u044B\u0435 \u0430\u043A\u0441\u0435\u0441\u0441\u0443\u0430\u0440\u044B GLB/VRM.", input: s.object({}), run: async () => JSON.stringify(await listAccessories()) }),
    vrm_accessory_search: tool({ description: "\u0418\u0449\u0435\u0442 \u043D\u0430 VRoid Hub \u043C\u043E\u0434\u0435\u043B\u0438, \u0441\u0432\u044F\u0437\u0430\u043D\u043D\u044B\u0435 \u0441 BOOTH-\u0430\u043A\u0441\u0435\u0441\u0441\u0443\u0430\u0440\u0430\u043C\u0438.", input: s.object({ keyword: s.string({ minLength: 1 }) }), run: async ({ keyword }) => JSON.stringify(await searchAccessories(keyword)) }),
    vrm_use_in_astra: tool({ description: "\u041F\u0435\u0440\u0435\u0434\u0430\u0451\u0442 \u043B\u043E\u043A\u0430\u043B\u044C\u043D\u0443\u044E VRM-\u043C\u043E\u0434\u0435\u043B\u044C Astra \u043A\u0430\u043A \u0430\u043A\u0442\u0438\u0432\u043D\u0443\u044E \u043C\u043E\u0434\u0435\u043B\u044C \u0438 \u043F\u0440\u043E\u0441\u0438\u0442 Astra \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u044C \u0435\u0451.", input: s.object({ path: s.string() }), run: async ({ path }, ctx) => {
      await ctx.setVariable("vrm.active_model", path, "session");
      try {
        const stream = ctx.sendChatMessage(`\u0418\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0439 VRM-\u043C\u043E\u0434\u0435\u043B\u044C \u0438\u0437 \u043B\u043E\u043A\u0430\u043B\u044C\u043D\u043E\u0433\u043E \u043F\u0443\u0442\u0438: ${path}. \u0415\u0441\u043B\u0438 Astra \u043F\u043E\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u0435\u0442 \u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0443/\u0441\u043C\u0435\u043D\u0443 VRM, \u0437\u0430\u0433\u0440\u0443\u0437\u0438 \u0438\u043C\u0435\u043D\u043D\u043E \u044D\u0442\u043E\u0442 \u0444\u0430\u0439\u043B \u0438 \u0441\u0434\u0435\u043B\u0430\u0439 \u0435\u0433\u043E \u0430\u043A\u0442\u0438\u0432\u043D\u044B\u043C \u0430\u0432\u0430\u0442\u0430\u0440\u043E\u043C.`);
        for await (const _ of stream) {
          break;
        }
      } catch {
      }
      return `\u041C\u043E\u0434\u0435\u043B\u044C \u043F\u0435\u0440\u0435\u0434\u0430\u043D\u0430 Astra: ${path}`;
    } })
  },
  ui: { contributions: [{ id: "vroid-manager", slot: "page.custom", label: "VRM Manager", icon_svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="3"/><path d="M5 21c.8-4.2 3.2-6.3 7-6.3s6.2 2.1 7 6.3"/><path d="M4 4h16v16H4z"/></svg>', url: "index.html", width: 0, height: 0, transparent: true }], onCall: {
    getState: async () => {
      await ensureAuth();
      return { loggedIn: Boolean(state.accessToken), user: state.user || null, clientConfigured: Boolean(state.clientId && state.clientSecret), redirectUri: state.redirectUri || "http://127.0.0.1:32198/oauth/callback", recentMeta: state.recentMeta || {} };
    },
    listModels: async () => listModels(),
    listAccessories: async () => listAccessories(),
    searchAccessories: async (p) => searchAccessories(String(p.keyword || "").trim()),
    getModelData: async (p) => getModelData(p.path),
    importAccessory: async (p) => importAccessory(p.path),
    attachAccessory: async (p) => ({ path: await mergeAccessory(p.modelPath, p.accessoryPath, p.boneIndex) }),
    inspectModel: async (p) => inspectModel(p.path),
    hideNode: async (p) => ({ path: await setNodeVisible(p.path, p.nodeIndex, false) }),
    showNode: async (p) => ({ path: await setNodeVisible(p.path, p.nodeIndex, true) }),
    openFile: async () => {
      const script = `Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.OpenFileDialog; $d.Filter='VRM (*.vrm)|*.vrm|GLB (*.glb)|*.glb|All files (*.*)|*.*'; if($d.ShowDialog() -eq 'OK'){Write-Output $d.FileName}`;
      return { path: await ps(script) };
    },
    importFile: async (p) => {
      const dst = (0, import_node_path.join)(LIB, (0, import_node_path.basename)(p.path));
      await import_node_fs.promises.copyFile(p.path, dst);
      return { path: dst };
    },
    importToAstra: async (p, ctx) => {
      return await installToAstraLibrary(String(p.path || ""));
    },
    useInAstra: async (p, ctx) => {
      const path = String(p.path || "");
      if (!path) throw new Error("\u041D\u0435 \u0443\u043A\u0430\u0437\u0430\u043D \u043F\u0443\u0442\u044C \u043A VRM.");
      await ctx.setVariable("vrm.active_model", path, "session");
      try {
        const stream = ctx.sendChatMessage(`\u0412\u044B\u0431\u0440\u0430\u043D VRM-\u0444\u0430\u0439\u043B \u0434\u043B\u044F Astra: ${path}. \u0415\u0441\u043B\u0438 \u0432 \u044D\u0442\u043E\u0439 \u0441\u0431\u043E\u0440\u043A\u0435 Astra \u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D \u0438\u043D\u0441\u0442\u0440\u0443\u043C\u0435\u043D\u0442 \u0441\u043C\u0435\u043D\u044B VRM-\u0430\u0432\u0430\u0442\u0430\u0440\u0430, \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0439 \u0438\u043C\u0435\u043D\u043D\u043E \u044D\u0442\u043E\u0442 \u0444\u0430\u0439\u043B.`);
        for await (const _ of stream) {
          break;
        }
      } catch {
      }
      return { ok: true, message: `VRM \u0432\u044B\u0431\u0440\u0430\u043D: ${(0, import_node_path.basename)(path)}` };
    },
    setClient: async (p) => {
      state.clientId = p.clientId;
      state.clientSecret = p.clientSecret;
      state.redirectUri = p.redirectUri || "http://127.0.0.1:32198/oauth/callback";
      state.scope = p.scope || "default";
      await saveState();
      return { ok: true };
    },
    startLogin: async () => {
      if (!state.clientId || !state.clientSecret) throw new Error("\u0421\u043D\u0430\u0447\u0430\u043B\u0430 \u0441\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u0435 Client ID \u0438 Client Secret VRoid Hub \u0432 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0430\u0445.");
      if (!state.redirectUri) state.redirectUri = "http://127.0.0.1:32198/oauth/callback";
      await startOAuthCallback();
      return { url: await beginOAuth(state.clientId, state.redirectUri, state.scope || "default") };
    },
    testConnection: async () => {
      if (!await ensureAuth()) return { ok: false, message: "\u0410\u0432\u0442\u043E\u0440\u0438\u0437\u0430\u0446\u0438\u044F \u043D\u0435 \u0432\u044B\u043F\u043E\u043B\u043D\u0435\u043D\u0430 \u0438\u043B\u0438 \u0438\u0441\u0442\u0435\u043A\u043B\u0430." };
      const profile = await api("/api/account");
      const udata = profile?.data?.user_detail?.user || profile?.data?.user || null;
      if (udata) state.user = { id: udata.id, name: udata.name, icon: udata.icon?.sq170?.url };
      await saveState();
      return { ok: true, user: state.user || null };
    },
    logout: async () => {
      try {
        if (state.accessToken && state.clientId && state.clientSecret) {
          await fetch(API + "/oauth/revoke", { method: "POST", headers: { "X-Api-Version": API_VERSION, "Content-Type": "application/x-www-form-urlencoded", "Authorization": `Bearer ${state.accessToken}` }, body: new URLSearchParams({ client_id: state.clientId, client_secret: state.clientSecret, token: state.accessToken }) });
        }
      } catch {
      }
      state.accessToken = void 0;
      state.refreshToken = void 0;
      state.expiresAt = void 0;
      state.user = void 0;
      await saveState();
      return { ok: true };
    },
    search: async (p) => {
      if (!await ensureAuth()) throw new Error("\u0421\u043D\u0430\u0447\u0430\u043B\u0430 \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0438\u0442\u0435 VRoid Hub. \u041E\u0442\u043A\u0440\u043E\u0439\u0442\u0435 \xAB\u041D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438\xBB \u0438 \u0432\u044B\u043F\u043E\u043B\u043D\u0438\u0442\u0435 \u0432\u0445\u043E\u0434.");
      const keyword = String(p.keyword || "").trim();
      if (!keyword) throw new Error("\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u0437\u0430\u043F\u0440\u043E\u0441 \u0434\u043B\u044F \u043F\u043E\u0438\u0441\u043A\u0430.");
      const RU = {
        "\u0434\u0435\u0432\u0443\u0448\u043A\u0430": ["girl", "female", "woman"],
        "\u0434\u0435\u0432\u0443\u0448\u043A\u0438": ["girl", "female", "woman"],
        "\u043F\u0430\u0440\u0435\u043D\u044C": ["boy", "male", "man"],
        "\u043C\u0443\u0436\u0447\u0438\u043D\u0430": ["man", "male"],
        "\u0436\u0435\u043D\u0449\u0438\u043D\u0430": ["woman", "female"],
        "\u0432\u043E\u043B\u043E\u0441\u044B": ["hair", "hairstyle"],
        "\u043F\u0440\u0438\u0447\u0435\u0441\u043A\u0430": ["hair", "hairstyle"],
        "\u043E\u0434\u0435\u0436\u0434\u0430": ["clothes", "outfit", "dress"],
        "\u043F\u043B\u0430\u0442\u044C\u0435": ["dress"],
        "\u043A\u043E\u0441\u0442\u044E\u043C": ["suit", "outfit"],
        "\u0430\u043A\u0441\u0435\u0441\u0441\u0443\u0430\u0440": ["accessory"],
        "\u0430\u043A\u0441\u0435\u0441\u0441\u0443\u0430\u0440\u044B": ["accessory"],
        "\u043E\u0447\u043A\u0438": ["glasses"],
        "\u0443\u0448\u0438": ["ears", "animal ears"],
        "\u043A\u043E\u0448\u0430\u0447\u044C\u0438 \u0443\u0448\u0438": ["cat ears"],
        "\u0445\u0432\u043E\u0441\u0442": ["tail"],
        "\u043A\u0440\u044B\u043B\u044C\u044F": ["wings"],
        "\u0448\u043B\u0435\u043C": ["helmet"],
        "\u043C\u0435\u0447": ["sword"],
        "\u0440\u043E\u0431\u043E\u0442": ["robot", "android"],
        "\u043A\u0438\u0431\u0435\u0440\u043F\u0430\u043D\u043A": ["cyberpunk"],
        "\u0430\u043D\u0438\u043C\u0435": ["anime"],
        "\u0444\u044D\u043D\u0442\u0435\u0437\u0438": ["fantasy"],
        "\u0432\u043E\u0438\u043D": ["warrior"],
        "\u043C\u0430\u0433": ["mage", "wizard"],
        "\u0432\u0435\u0434\u044C\u043C\u0430": ["witch"],
        "\u0432\u0430\u043C\u043F\u0438\u0440": ["vampire"],
        "\u043C\u0438\u043B\u044B\u0439": ["cute"],
        "\u043A\u0440\u0430\u0441\u0438\u0432\u044B\u0439": ["beautiful"],
        "\u0433\u043E\u0442\u0438\u043A\u0430": ["gothic"],
        "\u0433\u043E\u0442\u0438\u0447\u0435\u0441\u043A\u0438\u0439": ["gothic"],
        "\u0448\u043A\u043E\u043B\u044C\u043D\u0438\u0446\u0430": ["schoolgirl"],
        "\u0448\u043A\u043E\u043B\u044C\u043D\u0438\u043A": ["schoolboy"],
        "\u043A\u0440\u0430\u0441\u043D\u044B\u0439": ["red"],
        "\u0441\u0438\u043D\u0438\u0439": ["blue"],
        "\u0433\u043E\u043B\u0443\u0431\u043E\u0439": ["light blue", "cyan"],
        "\u0437\u0435\u043B\u0435\u043D\u044B\u0439": ["green"],
        "\u0437\u0435\u043B\u0451\u043D\u044B\u0439": ["green"],
        "\u0447\u0435\u0440\u043D\u044B\u0439": ["black"],
        "\u0447\u0451\u0440\u043D\u044B\u0439": ["black"],
        "\u0431\u0435\u043B\u044B\u0439": ["white"],
        "\u0440\u043E\u0437\u043E\u0432\u044B\u0439": ["pink"],
        "\u0444\u0438\u043E\u043B\u0435\u0442\u043E\u0432\u044B\u0439": ["purple"],
        "\u0436\u0435\u043B\u0442\u044B\u0439": ["yellow"],
        "\u0436\u0451\u043B\u0442\u044B\u0439": ["yellow"],
        "\u043A\u043E\u0442": ["cat"],
        "\u043A\u043E\u0448\u043A\u0430": ["cat"],
        "\u043B\u0438\u0441\u0430": ["fox"],
        "\u0437\u0430\u044F\u0446": ["rabbit"],
        "\u043A\u0440\u043E\u043B\u0438\u043A": ["rabbit"],
        "\u0434\u0440\u0430\u043A\u043E\u043D": ["dragon"]
      };
      const normalized = keyword.toLowerCase().replace(/ё/g, "\u0435");
      const tokens = normalized.split(/\s+/).filter(Boolean);
      const variants = [];
      const add = (x) => {
        if (x && !variants.includes(x)) variants.push(x);
      };
      if (/^[a-z0-9\s_-]+$/i.test(keyword)) add(keyword);
      for (const token of tokens) {
        for (const v of RU[token] || []) add(v);
      }
      if (tokens.length > 1) {
        const translated = tokens.flatMap((t) => RU[t] || []);
        if (translated.length) add(translated.join(" "));
      }
      add(keyword);
      const terms = variants.slice(0, 10);
      const batches = await Promise.all(terms.map(async (term) => {
        const q = new URLSearchParams();
        q.set("keyword", term);
        q.set("count", "50");
        q.set("sort", "_score");
        if (p.downloadable === true) q.set("is_downloadable", "true");
        const result = await api(`/api/search/character_models?${q.toString()}`);
        return Array.isArray(result?.data) ? result.data : [];
      }));
      const seen = /* @__PURE__ */ new Set();
      const data = [];
      for (const batch of batches) for (const item of batch) {
        const id = String(item.id || item.character_model_id || "");
        if (id && !seen.has(id)) {
          seen.add(id);
          data.push(item);
        }
      }
      return { ok: true, data: data.slice(0, 100), count: Math.min(data.length, 100), query: keyword, variants: terms };
    },
    modelDetail: async (p) => api(`/api/character_models/${encodeURIComponent(p.id)}`),
    downloadModel: async (p) => {
      if (!await ensureAuth()) throw new Error("\u0421\u043D\u0430\u0447\u0430\u043B\u0430 \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0438\u0442\u0435 VRoid Hub.");
      const lic = await api("/api/download_licenses", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ character_model_id: p.id }) });
      const r = await fetch(`${API}/api/download_licenses/${lic.data.id}/download`, { headers: authHeaders(), redirect: "manual" });
      const loc = r.headers.get("location");
      if (!loc) throw new Error(`\u041D\u0435 \u043F\u043E\u043B\u0443\u0447\u0435\u043D\u0430 \u0441\u0441\u044B\u043B\u043A\u0430 \u0441\u043A\u0430\u0447\u0438\u0432\u0430\u043D\u0438\u044F (${r.status})`);
      const file = await fetch(loc);
      if (!file.ok) throw new Error(`S3 download ${file.status}`);
      const arr = Buffer.from(await file.arrayBuffer());
      const safe = (p.name || `vroid-${p.id}`).replace(/[^a-zA-Z0-9а-яА-Я _.-]/g, "_");
      const path = (0, import_node_path.join)(LIB, `${safe}.vrm`);
      await import_node_fs.promises.writeFile(path, arr);
      state.recent = [path, ...(state.recent || []).filter((x) => x !== path)].slice(0, 50);
      state.recentMeta = state.recentMeta || {};
      state.recentMeta[path] = { preview: p.preview || p.thumbnail || p.image || void 0, sourceId: String(p.id), sourceName: p.name || String(p.id) };
      await saveState();
      return { path, size: arr.length, preview: state.recentMeta[path].preview || null };
    }
  } },
  onStart: async () => {
    await ensure();
  },
  healthCheck: () => ({ healthy: true, status: "ok" })
});
if (require.main === module) app.run();
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  app
});
