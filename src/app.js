'use strict';

/* ==========================================================
 * folder-icons — 为 Morz 文件树的文件夹设置 Lucide 图标
 * 依赖 build.js 注入的全局变量：LUCIDE / ZH_ALIAS
 *
 * 交互面：
 *   - 文件树右键 → 光标处浮层（主路径，不占工作区）
 *   - 主区域视图 → 总览 / 名称规则（低频、需要空间）
 * ========================================================== */

const STORE_KEY = 'config';
const MODE_KEY = 'storeMode';
const VIEW_ID = 'folder-icons:view';
/* 库内存储模式下的文件名，固定放在库根目录 */
const VAULT_FILE = '.folder-icons.json';

let C = null;                       // ctx
/* 'plugin' = 插件私有存储（本机默认）；'vault' = 库根目录下的 .folder-icons.json */
let storeMode = 'plugin';
let lastWritten = '';               // 本插件最近一次写进库文件的原文，用来识别「自己写的」事件

/* ---------------- 多库隔离 ----------------
 * 宿主的 ctx.storage 只按「插件 id」隔离，不区分笔记库。若 E:\test 和 D:\test 里都有
 * projects/ 这种同名目录，扁平存一份配置就会互相串用——在 A 库设的图标跑到 B 库去。
 * 所以落盘改成按库分区：byWs[库标识] = { folders, rules }，cfg 始终指向「当前库」那一份。
 * 库标识来源优先级：宿主给的文件树行 workspaceId > 右键目标 workspaceId > 上次用的库。
 */
let byWs = {};                      // { wsKey: { folders, rules } }
let currentWs = 'default';
let cfg = { folders: {}, rules: [] };   // 与 byWs[currentWs] 同一个对象，后者改动即时可见
let legacyPending = false;          // 升级前的扁平配置，等认出真实库时整份搬过去
let wsDiag = { entryWs: null };     // entry 是否带 workspaceId：null 未知 / true 有 / false 没有
let wsRepaint = false;              // 装饰过程中途切了库，需要补一次重绘
let ui = {
  enabled: true, defaultIcon: '', badge: '',
  showTooltip: true, rulesEnabled: true,
};

let decoHandle = null;
let activeContainer = null;         // 主区域视图容器
let gridTeardown = null;            // 上一份图标网格的滚动监听清理函数
let gridOwner = null;               // 这套监听挂在哪块容器上，浮层关闭时据此回收
let viewTab = 'icons';
let target = { path: '', name: '' };
let queryTxt = '';
let regexCache = new Map();
let idxLower = new Map();           // 小写路径 -> 真实 key，保证大小写兜底也是 O(1)

/* 浮层状态 */
let popEl = null;
let popCleanup = [];
let pointer = { x: 0, y: 0 };

/* ---------------- 图标渲染 ---------------- */

const MARK = Object.create(null);

function markOf(name) {
  if (!name) return null;
  let m = MARK[name];
  if (m !== undefined) return m || null;
  const nodes = LUCIDE[name];
  if (!nodes) { MARK[name] = ''; return null; }
  let s = '';
  for (let i = 0; i < nodes.length; i++) {
    const p = nodes[i];
    if (p.charCodeAt(0) === 64) {            // '@circle cx=10,cy=10,r=8'
      const sp = p.indexOf(' ');
      const tag = p.slice(1, sp);
      const attrs = p.slice(sp + 1).split(',');
      let a = '';
      for (let j = 0; j < attrs.length; j++) {
        const eq = attrs[j].indexOf('=');
        a += ' ' + attrs[j].slice(0, eq) + '="' + attrs[j].slice(eq + 1) + '"';
      }
      s += '<' + tag + a + '/>';
    } else {
      s += '<path d="' + p + '"/>';
    }
  }
  MARK[name] = s;
  return s;
}

function svgEl(name, size) {
  const mark = markOf(name) || markOf('folder') || '';
  const span = document.createElement('span');
  span.className = 'fi-svg';
  span.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"' +
    ' stroke-linecap="round" stroke-linejoin="round" width="' + size + '" height="' + size + '">' +
    mark + '</svg>';
  return span;
}

/* ---------------- 检索 ---------------- */

const NAMES = Object.keys(LUCIDE).sort();
const ALIAS = Object.create(null);

function buildAliasIndex() {
  for (const kw in ZH_ALIAS) {
    const list = ZH_ALIAS[kw];
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      if (!LUCIDE[n]) continue;
      ALIAS[n] = ALIAS[n] ? ALIAS[n] + ' ' + kw : kw;
    }
  }
}

function searchIcons(q) {
  const t = String(q || '').trim().toLowerCase();
  if (!t) return NAMES;
  const pref = [], sub = [];
  for (let i = 0; i < NAMES.length; i++) {
    const n = NAMES[i];
    const hay = ALIAS[n] ? n + ' ' + ALIAS[n] : n;
    if (hay.indexOf(t) === -1) continue;
    if (n.indexOf(t) === 0) pref.push(n); else sub.push(n);
  }
  /* 前缀命中里短名优先：搜 cal 时 calendar 排在 calculator 前 */
  pref.sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
  return pref.concat(sub);
}

/* ---------------- 配置读写 ---------------- */

function wsKeyOf(v) {
  if (typeof v !== 'string') return 'default';
  const s = v.trim();
  return s || 'default';
}

/** 让 cfg 指向某个库的分区；该库首次露面时才建表 */
function activateWs(key) {
  const k = wsKeyOf(key);
  if (!byWs[k]) byWs[k] = { folders: {}, rules: [] };
  currentWs = k;
  cfg = byWs[k];
  reindex();
  regexCache.clear();
}

/**
 * 切到另一个库。返回是否真的切了。
 * 升级前的扁平配置属于「当时那个库」，第一次认出真实库标识时整份搬过去，避免升级后图标消失。
 */
function switchWs(key) {
  const k = wsKeyOf(key);
  if (k === currentWs) return false;
  if (legacyPending && k !== 'default') {
    const old = byWs.default;
    const cur = byWs[k];
    const empty = !cur || (!Object.keys(cur.folders).length && !cur.rules.length);
    legacyPending = false;
    if (old && empty) byWs[k] = old;
    delete byWs.default;
  }
  activateWs(k);
  return true;
}

async function loadCfg() {
  try { storeMode = (await C.storage.get(MODE_KEY)) === 'vault' ? 'vault' : 'plugin'; }
  catch (e) { storeMode = 'plugin'; }

  let raw = null;
  try { raw = await C.storage.get(STORE_KEY); } catch (e) { raw = null; }

  /* 库内模式：以库文件为准；文件不存在就用本机副本补写一份 */
  let seedVault = false;
  if (storeMode === 'vault') {
    const fromFile = await readVaultCfg();
    if (fromFile) raw = fromFile;
    else if (raw) seedVault = true;
  }

  byWs = {};
  legacyPending = false;

  const part = (p) => ({
    folders: (p && p.folders && typeof p.folders === 'object') ? p.folders : {},
    rules: (p && Array.isArray(p.rules)) ? p.rules : [],
  });

  if (raw && raw.byWs && typeof raw.byWs === 'object' && !Array.isArray(raw.byWs)) {
    const ks = Object.keys(raw.byWs);
    for (let i = 0; i < ks.length; i++) {
      if (raw.byWs[ks[i]] && typeof raw.byWs[ks[i]] === 'object') byWs[ks[i]] = part(raw.byWs[ks[i]]);
    }
    let startKey = 'default';
    if (raw.last && byWs[raw.last]) startKey = raw.last;
    else { const k0 = Object.keys(byWs)[0]; if (k0) startKey = k0; }
    activateWs(startKey);
  } else if (raw && raw.folders && typeof raw.folders === 'object') {
    /* v2 及更早：一份扁平配置，无从得知属于哪个库 */
    byWs.default = part(raw);
    legacyPending = true;
    activateWs('default');
  } else {
    activateWs('default');
  }

  /* 路径口径统一：反斜杠 / 重复分隔符 / 首尾斜杠；跨库一起清 */
  let dirty = false;
  const wkeys = Object.keys(byWs);
  for (let w = 0; w < wkeys.length; w++) {
    const box = byWs[wkeys[w]];
    const clean = {};
    const keys = Object.keys(box.folders);
    for (let i = 0; i < keys.length; i++) {
      const k = normPath(keys[i]);
      if (!k || clean[k]) { dirty = true; continue; }
      if (k !== keys[i]) dirty = true;
      clean[k] = box.folders[keys[i]];
    }
    box.folders = clean;
  }
  reindex();
  regexCache.clear();

  if (seedVault) await writeVaultCfg(vaultSnapshot());
  if (dirty) await saveCfg();      // 归一结果落盘，避免每次启动都重算
}

function snapshotOf() {
  return { v: 3, byWs: byWs, last: currentWs };
}

/* 库内文件属于某个具体的库，只写这个库那一份，别把其它库的配置搬进来 */
function vaultSnapshot() {
  const one = {};
  one[currentWs] = { folders: cfg.folders, rules: cfg.rules };
  return { v: 3, byWs: one, last: currentWs };
}

async function saveCfg(opts) {
  try {
    await C.storage.set(STORE_KEY, snapshotOf());
  } catch (e) {
    C.ui.notice('保存失败：' + (e && e.message ? e.message : e), { kind: 'error' });
  }
  /* keepVaultFile：只更新本机副本，不回写库文件（外部改动读回时用，避免覆盖用户的排版） */
  if (storeMode === 'vault' && !(opts && opts.keepVaultFile)) await writeVaultCfg(vaultSnapshot());
}

/* ---------------- 库内文件存储 ---------------- */

async function readVaultCfg() {
  try {
    if (!(await C.vault.exists(VAULT_FILE))) return null;
    const txt = await C.vault.read(VAULT_FILE);
    if (!txt) return null;
    lastWritten = txt;
    const data = JSON.parse(txt);
    return (data && typeof data === 'object' && !Array.isArray(data)) ? data : null;
  } catch (e) {
    C.ui.notice('读取库内图标文件失败：' + (e && e.message ? e.message : e), { kind: 'error' });
    return null;
  }
}

async function writeVaultCfg(data) {
  const txt = JSON.stringify(data, null, 2) + '\n';
  try {
    if (await C.vault.exists(VAULT_FILE)) await C.vault.write(VAULT_FILE, txt);
    else await C.vault.create(VAULT_FILE, txt);
    lastWritten = txt;
    return true;
  } catch (e) {
    C.ui.notice('写入库内图标文件失败：' + (e && e.message ? e.message : e), { kind: 'error' });
    return false;
  }
}

/** 切换存储位置；切到库内时把当前数据立即写一份过去 */
async function setStoreMode(mode) {
  const next = mode === 'vault' ? 'vault' : 'plugin';
  if (next === storeMode) return true;
  if (next === 'vault') {
    const ok = await writeVaultCfg(vaultSnapshot());
    if (!ok) return false;
  }
  storeMode = next;
  try { await C.storage.set(MODE_KEY, next); } catch (e) { /* noop */ }
  await saveCfg();
  return true;
}

/* 库文件被外部改动（其它设备同步、用户手改）时读回来 */
let vaultTouchTimer = null;
function onVaultFileTouched(p) {
  if (storeMode !== 'vault') return;
  if (typeof p !== 'string' || normPath(p) !== VAULT_FILE) return;
  if (vaultTouchTimer) { try { clearTimeout(vaultTouchTimer); } catch (e) { /* noop */ } }
  vaultTouchTimer = setTimeout(async () => {
    vaultTouchTimer = null;
    if (storeMode !== 'vault') return;
    let txt = '';
    try { txt = await C.vault.read(VAULT_FILE); } catch (e) { return; }
    if (!txt || txt === lastWritten) return;      // 自己刚写的那次，忽略
    const res = importCfg(txt, true);
    if (typeof res === 'string') {
      C.ui.notice('库内图标文件读不了：' + res, { kind: 'error' });
      return;
    }
    lastWritten = txt;
    await saveCfg({ keepVaultFile: true });   // 本机副本跟上，但不回写文件
    refreshTree();
    repaintView();
    C.ui.notice('已从库内文件读回 ' + res.n + ' 项');
  }, 400);
}


async function loadSettings() {
  let s = {};
  try { s = (await C.settings.get()) || {}; } catch (e) { s = {}; }
  ui = {
    enabled: s.enabled !== false,
    defaultIcon: typeof s.defaultIcon === 'string' ? s.defaultIcon.trim() : '',
    badge: typeof s.badge === 'string' ? s.badge.trim() : '',
    showTooltip: s.showTooltip !== false,
    rulesEnabled: s.rulesEnabled !== false,
  };
}

/* ---------------- 装饰 ---------------- */

function entryPath(e) {
  if (!e) return '';
  if (typeof e.path === 'string' && e.path) return e.path;
  if (e.file && typeof e.file.path === 'string') return e.file.path;
  if (typeof e.filePath === 'string') return e.filePath;
  if (typeof e.name === 'string' && e.name) return e.name;
  return '';
}

function isDir(e) {
  const k = e && e.kind;
  if (k) return k === 'directory' || k === 'folder' || k === 'dir';
  if (typeof e.isFolder === 'boolean') return e.isFolder;
  if (typeof e.isDirectory === 'boolean') return e.isDirectory;
  return Array.isArray(e.children);
}

function baseOf(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

function dirOf(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

/* 全库统一的路径口径：正斜杠、无重复分隔符、无首尾斜杠 */
function normPath(p) {
  if (typeof p !== 'string' || !p) return '';
  let s = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  while (s.charAt(0) === '/') s = s.slice(1);
  while (s.length > 1 && s.charAt(s.length - 1) === '/') s = s.slice(0, -1);
  return s;
}

function reindex() {
  idxLower.clear();
  const keys = Object.keys(cfg.folders);
  for (let i = 0; i < keys.length; i++) idxLower.set(keys[i].toLowerCase(), keys[i]);
}

/* ---------------- 颜色工具 ---------------- */

/** 能否折成 #rrggbb（给取色器用）；主题变量、颜色名都折不了 */
function hexOf(v) {
  const s = String(v || '').trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return '#' + m[1][0] + m[1][0] + m[1][1] + m[1][1] + m[1][2] + m[1][2];
  m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) return '#' + m[1].toLowerCase();
  return '';
}

/** 空串合法（= 跟随主题）。其余必须是浏览器认得的 CSS 颜色或主题变量 */
function isCssColor(v) {
  const s = String(v || '').trim();
  if (!s) return true;
  if (/^var\(\s*--[-\w]+\s*(,[\s\S]*)?\)$/.test(s)) return true;
  try {
    if (typeof CSS !== 'undefined' && CSS && typeof CSS.supports === 'function') {
      return CSS.supports('color', s);
    }
  } catch (e) { /* 落到下面的正则兜底 */ }
  return /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s)
    || /^(rgb|rgba|hsl|hsla|color)\(/i.test(s)
    || /^[a-z]{3,24}$/i.test(s);
}

/** 真实 key：精确命中优先，其次大小写不敏感（Windows 下只改大小写的改名） */
function keyOf(p) {
  const k = normPath(p);
  if (!k) return '';
  if (cfg.folders[k]) return k;
  return idxLower.get(k.toLowerCase()) || '';
}

function getRec(p) {
  const k = keyOf(p);
  return k ? cfg.folders[k] : null;
}

function setRec(p, rec) {
  const k = keyOf(p) || normPath(p);
  if (!k) return '';
  cfg.folders[k] = rec;
  idxLower.set(k.toLowerCase(), k);
  return k;
}

function delRec(p) {
  const k = keyOf(p);
  if (!k) return false;
  delete cfg.folders[k];
  idxLower.delete(k.toLowerCase());
  return true;
}

function ruleIconOf(name) {
  if (!ui.rulesEnabled) return '';
  for (let i = 0; i < cfg.rules.length; i++) {
    const r = cfg.rules[i];
    if (!r || !r.icon) continue;
    const p = r.p || '';
    /* 关键词为空 = 还没填完，任何类型都不命中，避免新加的规则一把套住所有文件夹 */
    if (!p) continue;
    if (r.type === 'startsWith') {
      if (name.indexOf(p) === 0) return r.icon;
    } else if (r.type === 'regex') {
      let re = regexCache.get(p);
      if (re === undefined) {
        try { re = new RegExp(p); } catch (err) { re = null; }
        regexCache.set(p, re);
      }
      if (re && re.test(name)) return r.icon;
    } else {
      if (name.indexOf(p) !== -1) return r.icon;
    }
  }
  return '';
}

/** 装饰中途发现换了库：本批行已经按旧表画过，补一次重绘（限流，避免与宿主刷新互相触发） */
function scheduleWsRepaint() {
  if (wsRepaint) return;
  wsRepaint = true;
  setTimeout(() => {
    wsRepaint = false;
    saveCfg();                  // 把切库结果落盘，避免重启后又回到上一个库
    refreshTree();
    if (activeContainer && activeContainer.isConnected) repaintView();
  }, 40);
}

function decorateRow(entry) {
  if (!ui.enabled) return null;
  if (!entry || !isDir(entry)) return null;
  const path = normPath(entryPath(entry));
  if (!path) return null;

  /* 宿主若在文件树行上给出 workspaceId，就以它为准切库；没给则沿用当前库 */
  const wsRaw = entry.workspaceId || entry.vaultId
    || (entry.workspace && entry.workspace.id) || (entry.vault && entry.vault.id) || '';
  if (wsRaw) {
    wsDiag.entryWs = true;
    if (wsKeyOf(wsRaw) !== currentWs && switchWs(wsRaw)) scheduleWsRepaint();
  } else if (wsDiag.entryWs === null) {
    wsDiag.entryWs = false;
  }

  const rec = getRec(path);
  const icon = (rec && rec.icon) || ruleIconOf(baseOf(path)) || ui.defaultIcon;
  if (!icon) return null;

  const mark = markOf(icon);
  if (!mark) return null;

  const out = { icon: mark };
  /* 颜色只认该文件夹自身的记录，不继承任何全局值：留空即跟随主题 */
  const color = rec && rec.color;
  const badge = (rec && rec.badge) || ui.badge;
  if (color) out.color = color;
  if (badge) out.badge = badge;
  if (ui.showTooltip) out.tooltip = entry.name || baseOf(path);
  return out;
}

function refreshTree() {
  try { if (decoHandle && decoHandle.refresh) decoHandle.refresh(); } catch (e) { /* noop */ }
}

/** 这个文件夹当前的图标从哪来：手动 / 名称规则 / 全局默认 / 无 */
function sourceOf(path) {
  const rec = getRec(path);
  if (rec && rec.icon) return { kind: 'manual', icon: rec.icon, text: '已单独设置，点其它图标即可覆盖' };
  const r = ruleIconOf(baseOf(path));
  if (r) return { kind: 'rule', icon: r, text: '来自名称规则，选图标后改为单独设置' };
  if (ui.defaultIcon) return { kind: 'default', icon: ui.defaultIcon, text: '来自全局默认，选图标后改为单独设置' };
  return { kind: 'none', icon: '', text: '未设置图标' };
}

/* ---------------- 目录改名迁移 ---------------- */

/**
 * 把挂在 oldDir 及其子目录下的配置整体搬到 newDir。
 * 只在确认 oldDir 已不存在（目录级改名/移动）时调用，避免单文件移动误改文件夹图标。
 */
function migrateDir(oldDir, newDir) {
  if (!oldDir || !newDir || oldDir === newDir) return false;
  let hit = false;
  const keys = Object.keys(cfg.folders);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    let mapped = null;
    if (k === oldDir) mapped = newDir;
    else if (k.indexOf(oldDir + '/') === 0) mapped = newDir + k.slice(oldDir.length);
    if (!mapped || mapped === k) continue;
    if (!cfg.folders[mapped]) cfg.folders[mapped] = cfg.folders[k];
    delete cfg.folders[k];
    hit = true;
  }
  if (hit) reindex();
  return hit;
}

/* 改名事件是"每个受影响文件一条"，先缓存目录对，攒完再验一次剩量 */
const pendingMoves = new Map();
let flushTimer = null;

function queueMove(oldDir, newDir) {
  if (!oldDir || !newDir || oldDir === newDir) return;
  if (!pendingMoves.has(oldDir)) pendingMoves.set(oldDir, newDir);
}

function scheduleFlush() {
  if (flushTimer) return;
  const later = C.timers && C.timers.setTimeout ? C.timers.setTimeout : setTimeout;
  flushTimer = later(flushMoves, 450);
}

async function flushMoves() {
  flushTimer = null;
  const pairs = Array.from(pendingMoves.entries());
  pendingMoves.clear();
  if (!pairs.length) return;

  let files = null;
  try { files = await C.vault.list(); } catch (e) { files = null; }
  if (!files) return;

  let hit = false;
  for (let i = 0; i < pairs.length; i++) {
    const oldDir = pairs[i][0];
    const newDir = pairs[i][1];
    let left = false;
    for (let j = 0; j < files.length; j++) {
      const p = files[j] && files[j].path;
      if (typeof p === 'string' && p.indexOf(oldDir + '/') === 0) { left = true; break; }
    }
    if (left) continue;                       // 旧目录还有文件 → 只是移走文件
    if (migrateDir(oldDir, newDir)) hit = true;
  }

  if (hit) {
    await saveCfg();
    refreshTree();
    repaintView();
  }
}

function onRename(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return;

  let hit = false;
  if (migrateDir(a, b)) hit = true;
  else if (migrateDir(b, a)) hit = true;

  queueMove(dirOf(a), dirOf(b));
  queueMove(dirOf(b), dirOf(a));

  if (hit) {
    saveCfg();
    refreshTree();
    repaintView();
  }
  scheduleFlush();
}

/* ---------------- 样式 ---------------- */

function injectStyle() {
  const css = `
.fi-root{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--text-color,var(--text-normal,#ddd));font-size:13px}
.fi-top{display:flex;gap:8px;align-items:center;padding:10px 14px;border-bottom:1px solid var(--background-modifier-border,#333);flex-wrap:wrap}
.fi-tab{padding:4px 12px;border-radius:6px;cursor:pointer;border:1px solid transparent;background:none;color:inherit;font:inherit;opacity:.7}
.fi-tab.on{opacity:1;background:var(--ui-hover,rgba(128,128,128,.15));border-color:var(--background-modifier-border,#333)}
.fi-pane{display:flex;flex-direction:column;min-height:0;flex:1}
.fi-pane-top{display:flex;gap:8px;align-items:center;padding:9px 12px 6px}
.fi-search{flex:1;min-width:0;padding:6px 10px;border-radius:6px;border:1px solid var(--background-modifier-border,#333);background:var(--ui-bg,transparent);color:inherit;font:inherit;outline:none}
.fi-search:focus{border-color:var(--primary-color,#60a5fa)}
.fi-body{flex:1;min-height:0;overflow:auto;padding:6px 12px 12px}
/* 视图页：左右留白与顶部 Tab 栏对齐（12px vs 14px 会让说明文字看着偏左） */
.fi-page{padding:12px 14px 16px}
.fi-target{display:flex;gap:8px;align-items:center;padding:0 12px 6px;flex-wrap:wrap}
.fi-target b{font-weight:600}
.fi-target code{padding:2px 6px;border-radius:4px;background:var(--ui-hover,rgba(128,128,128,.15));font-size:12px}
.fi-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(62px,1fr));gap:6px}
.fi-cell{display:flex;align-items:center;justify-content:center;height:62px;border-radius:6px;border:1px solid transparent;background:none;color:inherit;cursor:pointer;position:relative;padding:0}
.fi-cell:hover{background:var(--ui-hover,rgba(128,128,128,.15))}
.fi-cell.on{border-color:var(--primary-color,#60a5fa);background:var(--ui-hover,rgba(128,128,128,.15))}
.fi-cell .fi-name{position:absolute;bottom:4px;left:2px;right:2px;text-align:center;font-size:11px;line-height:1.15;opacity:.7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fi-empty{padding:22px 10px;text-align:center;opacity:.6;font-size:12px}
.fi-wide .fi-grid{grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:10px}
.fi-wide .fi-cell{height:94px;border-radius:9px}
.fi-wide .fi-cell .fi-name{font-size:12px;bottom:8px;opacity:.74}
.fi-foot{display:flex;gap:6px;align-items:center;padding:8px 12px;border-top:1px solid var(--background-modifier-border,#333);flex-wrap:wrap}
.fi-btn{padding:4px 10px;border-radius:6px;border:1px solid var(--background-modifier-border,#333);background:none;color:inherit;font:inherit;font-size:12px;cursor:pointer}
.fi-btn:hover{background:var(--ui-hover,rgba(128,128,128,.15))}
.fi-btn.warn{color:#f87171;border-color:#7f1d1d}
.fi-in{width:84px;padding:4px 8px;border-radius:6px;border:1px solid var(--background-modifier-border,#333);background:var(--ui-bg,transparent);color:inherit;font:inherit;font-size:12px}
.fi-in.bad{border-color:#f87171}
.fi-sw{width:26px;height:24px;padding:0;border:1px solid var(--background-modifier-border,#333);border-radius:6px;background:none;cursor:pointer;flex:none}
.fi-sw::-webkit-color-swatch-wrapper{padding:2px}
.fi-sw::-webkit-color-swatch{border:0;border-radius:4px}
.fi-label{opacity:.6;font-size:11px}
/* 宿主的全局 CSS 不保证 border-box；不锁住的话 100% 宽的输入框会溢出栅格、压到下一列上 */
.fi-root,.fi-root *,.fi-pop,.fi-pop *{box-sizing:border-box}
/* 末列给删除按钮固定 52px：列头那格是空的，用 auto 会塌成 0，导致列头与数据行错位 */
.fi-row{display:grid;grid-template-columns:30px 88px minmax(140px,420px) minmax(96px,132px) 52px;
  justify-content:start;column-gap:12px;align-items:center;padding:9px 0;
  border-bottom:1px solid var(--background-modifier-border,#2a2a2a)}
.fi-row>*{min-width:0}
.fi-row-head{border-bottom:1px solid var(--background-modifier-border,#333);font-size:11px;
  letter-spacing:.02em;opacity:.5;padding:0 0 7px}
/* 一行里所有控件同高，不再出现下拉比输入框高半头 */
.fi-row select,.fi-row .fi-in,.fi-row .fi-btn,.fi-iconbtn,.fi-namebtn{height:28px;font-size:12px}
.fi-row .fi-btn{padding:0 12px}
.fi-iconbtn{display:flex;align-items:center;justify-content:center;width:30px;padding:0;border-radius:6px;
  border:1px solid var(--background-modifier-border,#333);background:none;color:inherit;cursor:pointer}
.fi-iconbtn:hover{border-color:var(--primary-color,#60a5fa);background:var(--ui-hover,rgba(128,128,128,.15))}
.fi-namebtn{display:flex;align-items:center;gap:4px;padding:0 8px;border-radius:6px;
  border:1px solid var(--background-modifier-border,#333);background:none;color:inherit;font:inherit;
  font-size:12px;cursor:pointer;text-align:left;overflow:hidden}
.fi-namebtn span:first-child{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fi-namebtn .cv{flex:none;opacity:.45;font-size:10px}
.fi-namebtn:hover{border-color:var(--primary-color,#60a5fa);background:var(--ui-hover,rgba(128,128,128,.15))}
.fi-namebtn.empty{opacity:.85;border-style:dashed;color:var(--primary-color,#60a5fa)}
.fi-row select{padding:0 6px;border-radius:6px;border:1px solid var(--background-modifier-border,#333);
  background:var(--ui-bg,transparent);color:inherit;font:inherit;font-size:12px;cursor:pointer}
.fi-row .fi-in{padding:0 8px}
/* 说明文案：一句讲用途，一句讲规则；和工具条之间留出呼吸 */
.fi-lead{margin:2px 0 5px;font-size:13px;line-height:1.6}
.fi-note{margin:0 0 16px;font-size:12px;line-height:1.6;opacity:.55}
.fi-toolbar{display:flex;align-items:center;gap:10px;margin-bottom:14px}
.fi-toolbar .fi-count{margin:0}
.fi-hint{opacity:.55;font-size:12px;line-height:1.7;margin:6px 0 10px}
.fi-sub{margin:16px 0 4px;font-size:12px;font-weight:600;opacity:.8;letter-spacing:.02em}
.fi-sum{display:flex;align-items:baseline;gap:5px;padding:10px 12px;margin:2px 0 12px;border-radius:8px;background:var(--ui-hover,rgba(128,128,128,.12))}
.fi-sum-n{font-size:18px;font-weight:600;line-height:1}
.fi-sum .fi-label{margin-right:10px}
.fi-store{padding:10px 12px;margin-bottom:14px;border:1px solid var(--background-modifier-border,#333);border-radius:8px}
.fi-store-title{font-size:12px;font-weight:600;opacity:.8;margin-bottom:8px}
.fi-seg{display:inline-flex;padding:2px;gap:2px;border-radius:7px;background:var(--ui-hover,rgba(128,128,128,.12));margin-bottom:8px}
.fi-seg-b{padding:4px 12px;border:0;border-radius:5px;background:none;color:inherit;font:inherit;font-size:12px;cursor:pointer;opacity:.7}
.fi-seg-b:hover{opacity:1}
.fi-seg-b.on{opacity:1;background:var(--ui-bg,var(--background-primary,#2a2a2c));box-shadow:0 1px 2px rgba(0,0,0,.25)}
.fi-store-desc{font-size:12px;line-height:1.7;opacity:.62;margin-bottom:8px}
.fi-count{opacity:.55;font-size:11px;white-space:nowrap}
/* 当前图标来源提示 */
.fi-src{display:flex;align-items:center;gap:6px;padding:0 13px 6px;font-size:11px;opacity:.62}
.fi-src svg{flex:none}
.fi-src .fi-dot{width:6px;height:6px;border-radius:50%;flex:none;background:#8a8a8e}
.fi-src .fi-dot.manual{background:#60a5fa}
.fi-src .fi-dot.rule{background:#fbbf24}
.fi-src .fi-dot.default{background:#34d399}
.fi-cell.gone{opacity:.4}
.fi-cell.gone::after{content:'';position:absolute;inset:auto 4px 10px 4px;height:1px;background:currentColor;opacity:.5}
.fi-stale{display:flex;align-items:center;gap:8px;margin-top:12px;padding-top:10px;border-top:1px solid var(--background-modifier-border,#333);font-size:12px;opacity:.75}
/* 数据页 */
.fi-code{margin:8px 0;padding:10px 12px;border-radius:8px;border:1px solid var(--background-modifier-border,#333);
  background:var(--ui-hover,rgba(128,128,128,.08));font:11px/1.55 ui-monospace,Consolas,monospace;
  white-space:pre;overflow:auto;max-height:44vh}
.fi-code-input{width:100%;min-height:96px;padding:8px 10px;border-radius:8px;resize:vertical;
  border:1px solid var(--background-modifier-border,#333);background:var(--ui-bg,transparent);color:inherit;
  font:11px/1.55 ui-monospace,Consolas,monospace;outline:none;margin-bottom:8px}
.fi-code-input:focus{border-color:var(--primary-color,#60a5fa)}
.fi-actions{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}

/* 浮层：右键后光标处弹出，不占工作区 */
.fi-pop{position:fixed;z-index:9999;width:472px;max-height:min(78vh,600px);display:flex;flex-direction:column;
  background:var(--ui-bg,var(--background-primary,#232326));color:var(--text-color,#ddd);
  border:1px solid var(--background-modifier-border,#3a3a3c);border-radius:10px;
  box-shadow:0 18px 48px rgba(0,0,0,.5);overflow:hidden;font-size:13px}
.fi-pop-head{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--background-modifier-border,#3a3a3c)}
.fi-pop-head .nm{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fi-pop-head .sub{font-size:11px;opacity:.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fi-pop-head .x{margin-left:auto;flex:none;border:0;background:none;color:inherit;cursor:pointer;
  font-size:16px;line-height:1;padding:3px 7px;border-radius:5px;opacity:.55}
.fi-pop-head .x:hover{opacity:1;background:var(--ui-hover,rgba(128,128,128,.15))}
/* 名称规则的挑选浮层：比文件夹浮层矮一档，尽量落在所点按钮下方，不盖住正在编辑的那一行 */
.fi-pop-pick{width:440px;max-height:min(56vh,440px)}
`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  C.lifecycle.onUnload(() => { try { style.remove(); } catch (e) { /* noop */ } });
}

/* ---------------- DOM 小工具 ---------------- */

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/* ---------------- 失效配置巡检 ---------------- */

/**
 * 目录被删掉后，配置项会留成孤儿。这里只在总览里做一次只读核对：
 * exists() 说不存在才标记，且必须用户点「清理」才删，不自动动配置。
 */
async function scanStale(keys, grid, host) {
  if (!C.vault || typeof C.vault.exists !== 'function') return;
  const gone = [];
  for (let i = 0; i < keys.length; i++) {
    let ok = true;
    try { ok = await C.vault.exists(keys[i]); } catch (e) { ok = true; }
    if (ok === false) gone.push(keys[i]);
  }
  if (!gone.length) return;

  const set = new Set(gone);
  for (let i = 0; i < grid.children.length; i++) {
    const c = grid.children[i];
    if (set.has(c.title)) c.classList.add('gone');
  }
  const bar = h('div', 'fi-stale');
  bar.appendChild(h('span', null, gone.length + ' 项指向的文件夹已不存在'));
  const b = h('button', 'fi-btn', '清理');
  b.title = gone.join('\n');
  b.addEventListener('click', async () => {
    for (let i = 0; i < gone.length; i++) delRec(gone[i]);
    await saveCfg();
    refreshTree();
    repaintView();
    C.ui.notice('已清理 ' + gone.length + ' 项失效配置');
  });
  bar.appendChild(b);
  host.appendChild(bar);
}

/* ---------------- 选择器面板（视图与浮层共用） ---------------- */

function mountIconPane(host, opts) {
  opts = opts || {};
  host.replaceChildren();
  /* 全屏视图空间更大，格子和字号再放大一档（浮层用小一号） */
  if (opts.compact) host.classList.remove("fi-wide");
  else host.classList.add("fi-wide");

  /* 纯选图标模式：给名称规则用。没有目标文件夹，选中即回调，不碰 folders 配置 */
  const pick = opts.pick || null;

  /* 搜索行 */
  const top = h('div', 'fi-pane-top');
  const input = h('input', 'fi-search');
  input.type = 'search';
  input.placeholder = '搜索图标：calendar / 日历 / 会议';
  input.value = queryTxt;
  const count = h('span', 'fi-count');
  top.appendChild(input);
  top.appendChild(count);
  host.appendChild(top);

  /* 目标：视图里才显示路径，浮层标题已有 */
  if (!opts.compact && !pick && target.path) {
    const tg = h('div', 'fi-target');
    tg.appendChild(h('b', null, '目标文件夹'));
    tg.appendChild(h('code', null, target.path));
    host.appendChild(tg);
  }

  /* 当前图标是怎么来的：手动 / 规则 / 全局默认。切目录时靠这一行对齐认知 */
  const srcHost = h('div');
  host.appendChild(srcHost);
  let gridEl = null;

  function renderSrc() {
    srcHost.replaceChildren();
    if (pick || !target.path) return;
    const src = sourceOf(target.path);
    const line = h('div', 'fi-src');
    line.appendChild(h('span', 'fi-dot ' + src.kind));
    if (src.icon) line.appendChild(svgEl(src.icon, 13));
    line.appendChild(h('span', null, src.text));
    srcHost.appendChild(line);
  }
  renderSrc();

  /* 无目标 → 已配置总览 */
  if (!pick && !target.path) {
    const body0 = h('div', 'fi-body');
    host.appendChild(body0);
    const keys = Object.keys(cfg.folders).sort();
    count.textContent = keys.length + ' 个已设置';
    if (!keys.length) {
      body0.appendChild(h('div', 'fi-empty', '还没有配置任何文件夹图标。从文件树右键开始。'));
      return;
    }
    const g0 = h('div', 'fi-grid');
    keys.forEach((p) => {
      const rec = cfg.folders[p];
      const b = h('button', 'fi-cell');
      b.title = p;
      b.appendChild(svgEl(rec.icon, opts.compact ? 22 : 26));
      b.appendChild(h('span', 'fi-name', baseOf(p)));
      b.addEventListener('click', () => {
        target = { path: p, name: baseOf(p) };
        mountIconPane(host, opts);
      });
      g0.appendChild(b);
    });
    body0.appendChild(g0);
    scanStale(keys, g0, body0).catch(() => {});
    return;
  }

  const body = h('div', 'fi-body');
  host.appendChild(body);
  const foot = h('div', 'fi-foot');
  host.appendChild(foot);

  let selected = pick ? (pick.icon || '') : ((getRec(target.path) || {}).icon || '');

  function syncSelected() {
    if (!gridEl) return;
    const cells = gridEl.children;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      if (c.dataset.name === selected) c.classList.add('on');
      else c.classList.remove('on');
    }
  }

  function renderGrid() {
    body.replaceChildren();
    let list = searchIcons(queryTxt);
    /* 无搜索词时把当前图标置顶，保证一打开就能看到现状 */
    if (!queryTxt && selected) {
      const i = list.indexOf(selected);
      if (i > 0) { list = list.slice(); list.splice(i, 1); list.unshift(selected); }
    }
    count.textContent = list.length + ' 个图标';
    if (!list.length) {
      gridEl = null;
      body.appendChild(h('div', 'fi-empty', '没有匹配的图标。可换英文名试试，例如 calendar。'));
      return;
    }
    gridEl = h('div', 'fi-grid');
    body.appendChild(gridEl);
    let shown = 0;
    const BATCH = opts.compact ? 120 : 180;
    const more = h('div', 'fi-empty', '');

    function batch() {
      const end = Math.min(shown + BATCH, list.length);
      const frag = document.createDocumentFragment();
      for (let i = shown; i < end; i++) {
        const name = list[i];
        const b = h('button', 'fi-cell' + (name === selected ? ' on' : ''));
        b.dataset.name = name;
        b.title = name;
        b.appendChild(svgEl(name, opts.compact ? 22 : 26));
        b.appendChild(h('span', 'fi-name', name));
        b.addEventListener('click', () => applyIcon(name));
        frag.appendChild(b);
      }
      gridEl.appendChild(frag);
      shown = end;
      more.textContent = shown < list.length ? '滚动加载更多…（' + shown + ' / ' + list.length + '）' : '';
    }

    batch();
    if (shown < list.length) body.appendChild(more);

    /* 滚动加载不能只听 .fi-body 的 scroll。
       全屏视图里宿主给容器的高度不确定，.fi-root 的 height:100% 会退化成 auto，
       整条 flex 链失去确定高度，真正的滚动条落到外层容器上——.fi-body 自己永远不会滚，
       监听它的 scroll 就永远不触发。这就是「全屏模式滚动加载不生效」的根因。
       改为在 document 捕获阶段听 scroll（任何元素滚动都会经过捕获链），
       再用几何判断是否接近网格底部：容器自身可滚就用容器下沿，否则退回视口下沿。 */
    if (gridTeardown) { gridTeardown(); gridTeardown = null; }

    const raf = typeof requestAnimationFrame === 'function'
      ? (fn) => requestAnimationFrame(fn)
      : (fn) => setTimeout(fn, 16);

    let pending = 0;
    function nearEdge() {
      if (!gridEl || !gridEl.isConnected) return false;
      const r = gridEl.getBoundingClientRect();
      const box = body.getBoundingClientRect();
      /* 几何不可用（jsdom / 未挂载）时按「未知」处理：一次只放一批 */
      if (!r.height && !box.height) return true;
      const vh = window.innerHeight || document.documentElement.clientHeight || 0;
      const bodyScrolls = body.scrollHeight > body.clientHeight + 4;
      const edge = bodyScrolls ? box.bottom : vh;
      return r.bottom <= edge + 320;
    }
    function onScroll() {
      if (shown >= list.length) return;
      if (pending) return;
      pending = raf(() => {
        pending = 0;
        if (shown >= list.length) return;
        if (nearEdge()) batch();
      });
    }

    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    more.addEventListener('click', () => { if (shown < list.length) batch(); });
    more.style.cursor = 'pointer';

    let io = null;
    if (typeof IntersectionObserver === 'function') {
      try {
        io = new IntersectionObserver((es) => {
          for (let i = 0; i < es.length; i++) if (es[i].isIntersecting) { onScroll(); break; }
        }, { rootMargin: '400px' });
        io.observe(more);
      } catch (e) { io = null; }
    }

    gridTeardown = () => {
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      if (io) { try { io.disconnect(); } catch (e) { /* noop */ } }
      gridTeardown = null;
    };
    gridOwner = host;
  }

  async function applyIcon(name) {
    if (pick) { pick.onPick(name); return; }
    const prev = getRec(target.path) || {};
    const rec = { icon: name };
    if (prev.color) rec.color = prev.color;
    if (prev.badge) rec.badge = prev.badge;
    setRec(target.path, rec);
    selected = name;
    await saveCfg();
    refreshTree();
    syncSelected();
    renderSrc();
    renderFoot();
    C.ui.notice('已设置：' + (target.name || baseOf(target.path)) + ' → ' + name);
  }

  function renderFoot() {
    foot.replaceChildren();
    if (pick) {
      foot.appendChild(h('span', 'fi-label', '点一个图标即选中本行规则'));
      const cancel = h('button', 'fi-btn', '取消');
      cancel.addEventListener('click', () => { if (typeof pick.onCancel === 'function') pick.onCancel(); });
      foot.appendChild(cancel);
      return;
    }
    const rec = getRec(target.path);

    foot.appendChild(h('span', 'fi-label', '颜色'));
    const col = h('input', 'fi-in');
    col.placeholder = '留空=跟随主题';
    col.title = '只作用于这个文件夹的图标。留空即完全跟随主题；也可填 var(--primary-color) 这类主题变量。';
    col.value = (rec && rec.color) || '';
    foot.appendChild(col);

    /* 取色器：只负责往文本框里写 hex，写完仍可手改成主题变量 */
    const sw = h('input', 'fi-sw');
    sw.type = 'color';
    sw.title = '点此取色（写入 #rrggbb）';
    sw.value = hexOf(col.value) || '#60a5fa';
    sw.addEventListener('input', () => {
      col.value = sw.value;
      col.classList.remove('bad');
    });
    col.addEventListener('input', () => {
      col.classList.remove('bad');
      const hx = hexOf(col.value);
      if (hx) sw.value = hx;
    });
    foot.appendChild(sw);

    foot.appendChild(h('span', 'fi-label', '角标'));
    const bdg = h('input', 'fi-in');
    bdg.style.width = '46px';
    bdg.placeholder = ui.badge ? '继承 ' + ui.badge : '无';
    bdg.maxLength = 3;
    bdg.value = (rec && rec.badge) || '';
    foot.appendChild(bdg);

    async function commitStyle(verbose) {
      const cur = getRec(target.path);
      if (!cur) { C.ui.notice('请先选择一个图标'); return false; }
      const c = col.value.trim(), b = bdg.value.trim();
      if (c && !isCssColor(c)) {
        col.classList.add('bad');
        C.ui.notice('颜色写法无效：' + c + '（可用 #60a5fa / rosybrown / var(--primary-color)）', { kind: 'error' });
        return false;
      }
      col.classList.remove('bad');
      if (c) cur.color = c; else delete cur.color;
      if (b) cur.badge = b.slice(0, 3); else delete cur.badge;
      await saveCfg();
      refreshTree();
      if (verbose) C.ui.notice('样式已保存');
      return true;
    }

    /* 输入框失焦 / 回车即生效，不必再找「保存样式」按钮 */
    col.addEventListener('change', () => { commitStyle(false).catch(() => {}); });
    bdg.addEventListener('change', () => { commitStyle(false).catch(() => {}); });
    bdg.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitStyle(true).catch(() => {}); }
    });
    col.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitStyle(true).catch(() => {}); }
    });

    const saveBtn = h('button', 'fi-btn', '保存样式');
    saveBtn.addEventListener('click', () => { commitStyle(true).catch(() => {}); });
    foot.appendChild(saveBtn);

    if (rec) {
      const clr = h('button', 'fi-btn warn', '清除');
      clr.title = '恢复默认图标';
      clr.addEventListener('click', async () => {
        delRec(target.path);
        selected = '';
        await saveCfg();
        refreshTree();
        syncSelected();
        renderSrc();
        renderFoot();
        C.ui.notice('已恢复默认图标');
      });
      foot.appendChild(clr);
    }

    if (opts.onOpenFull) {
      const full = h('button', 'fi-btn', '完整面板');
      full.title = '打开总览 / 名称规则 / 数据';
      full.addEventListener('click', opts.onOpenFull);
      foot.appendChild(full);
    }
  }

  input.addEventListener('input', C.timers.debounce(() => {
    queryTxt = input.value;
    renderGrid();
  }, 140));

  renderGrid();
  renderFoot();
  if (opts.autofocus) input.focus();
}

/* ---------------- 名称规则 ---------------- */

function paintRules(host) {
  host.replaceChildren();

  host.appendChild(h('p', 'fi-lead',
    '名字命中关键词的文件夹，统一换成指定图标；新建的同类文件夹自动跟上。'));
  host.appendChild(h('p', 'fi-note',
    '自上而下取第一条命中；手动设过图标的文件夹优先。规则只换图标，不改颜色。'));

  const bar = h('div', 'fi-toolbar');
  const addBtn = h('button', 'fi-btn', '+ 新增规则');
  addBtn.addEventListener('click', async () => {
    /* 新规则故意不预置图标：没选图标前这条规则不生效，避免「看起来没反应」 */
    cfg.rules.push({ id: 'r' + Date.now(), type: 'contains', p: '', icon: '' });
    await saveCfg();
    refreshTree();
    paintRules(host);
  });
  bar.appendChild(addBtn);
  if (cfg.rules.length) bar.appendChild(h('span', 'fi-count', cfg.rules.length + ' 条'));
  host.appendChild(bar);

  if (!cfg.rules.length) {
    host.appendChild(h('div', 'fi-empty',
      '还没有规则。例：包含「会议」→ calendar，包含「周报」→ inbox，开头是「2026-」→ calendar-days。'));
    return;
  }

  /* 列头：四个格子依次是 图标 / 条件 / 关键词 / 套用图标；末列留给删除按钮占位，保证列宽与数据行一致 */
  const head = h('div', 'fi-row fi-row-head');
  head.appendChild(h('span', null, '图标'));
  head.appendChild(h('span', null, '判断方式'));
  head.appendChild(h('span', null, '文件夹名里的关键词'));
  head.appendChild(h('span', null, '套用图标'));
  head.appendChild(h('span'));
  host.appendChild(head);

  const wrap = h('div');
  cfg.rules.forEach((r, idx) => {
    const row = h('div', 'fi-row');

    /* 选中图标：左侧预览本身就是按钮，点了就开挑选浮层 */
    const iconBtn = h('button', 'fi-iconbtn');
    iconBtn.title = '点此挑选图标';
    iconBtn.appendChild(svgEl(r.icon || 'circle-dashed', 16));
    row.appendChild(iconBtn);

    const type = h('select');
    [['contains', '包含'], ['startsWith', '开头是'], ['regex', '正则']].forEach(([v, l]) => {
      const o = h('option', null, l);
      o.value = v;
      if (r.type === v) o.selected = true;
      type.appendChild(o);
    });
    type.addEventListener('change', async () => {
      r.type = type.value;
      regexCache.clear();
      await saveCfg(); refreshTree();
    });
    row.appendChild(type);

    const pat = h('input', 'fi-in');
    pat.style.width = '100%';
    pat.placeholder = r.type === 'regex' ? '^\\d{4}-\\d{2}$' : '例如：会议';
    pat.value = r.p || '';
    pat.addEventListener('input', C.timers.debounce(async () => {
      r.p = pat.value;
      regexCache.clear();
      await saveCfg(); refreshTree();
    }, 250));
    row.appendChild(pat);

    /* 图标名不再是裸输入框：按钮显示当前名，点开挑选 */
    const nameBtn = h('button', 'fi-namebtn' + (r.icon ? '' : ' empty'));
    nameBtn.title = '点此挑选图标';
    nameBtn.appendChild(h('span', null, r.icon || '选择图标'));
    nameBtn.appendChild(h('span', 'cv', '⌄'));
    row.appendChild(nameBtn);

    const openPicker = (anchorEl) => {
      openPickerAt(anchorEl, r.icon, async (name) => {
        r.icon = name;
        regexCache.clear();
        await saveCfg();
        refreshTree();
        paintRules(host);
        C.ui.notice('规则已改为：' + name + (r.p ? '（命中「' + r.p + '」的文件夹）' : '（填上关键词后生效）'));
      });
    };
    iconBtn.addEventListener('click', () => openPicker(iconBtn));
    nameBtn.addEventListener('click', () => openPicker(nameBtn));

    const del = h('button', 'fi-btn warn', '删除');
    del.addEventListener('click', async () => {
      cfg.rules.splice(idx, 1);
      await saveCfg(); refreshTree(); paintRules(host);
    });
    row.appendChild(del);

    wrap.appendChild(row);
  });
  host.appendChild(wrap);
}

/* ---------------- 数据页：把存储内容摊开 ---------------- */

function snapshotJSON() {
  return JSON.stringify(snapshotOf(), null, 2);
}

/** 校验并清洗一份 { folders, rules }；图标名必须真实存在，无效条目跳过计数 */
function cleanPart(src, acc) {
  const folders = {};
  Object.keys(src || {}).forEach((k) => {
    const p = normPath(k);
    const r = src[k];
    if (!p || !r || typeof r !== 'object' || typeof r.icon !== 'string' || !LUCIDE[r.icon]) { acc.skip++; return; }
    const out = { icon: r.icon };
    if (typeof r.color === 'string' && r.color) out.color = r.color;
    if (typeof r.badge === 'string' && r.badge) out.badge = r.badge.slice(0, 3);
    folders[p] = out;
    acc.n++;
  });
  return folders;
}

function cleanRules(list, fallback) {
  if (!Array.isArray(list)) return fallback;
  return list.filter((r) => r && typeof r.p === 'string' && typeof r.icon === 'string' && LUCIDE[r.icon]).slice(0, 8);
}

/**
 * 导入：认识两种形状。
 *   v3 { byWs: { 库: {folders, rules} }, last }  → 整份覆盖（多库备份的还原）
 *   v2 { folders, rules }                       → 只覆盖当前库
 * 图标名不存在的条目一律丢弃并计数，不写脏数据。
 */
function importCfg(text, only) {
  let data;
  try { data = JSON.parse(text); } catch (e) { return 'JSON 解析失败：' + (e && e.message ? e.message : e); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return '顶层必须是一个对象';

  const acc = { n: 0, skip: 0 };

  /* only：这份数据属于「当前库」，只覆盖当前库那一份，别动别的库 */
  if (only) {
    let one = data;
    if (data.byWs && typeof data.byWs === 'object' && !Array.isArray(data.byWs)) {
      one = (data.last && data.byWs[data.last]) || Object.values(data.byWs)[0] || {};
    }
    if (!one || typeof one !== 'object') return '备份里没有可用的数据';
    cfg.folders = cleanPart(one.folders, acc);
    cfg.rules = cleanRules(one.rules, cfg.rules);
    reindex();
    regexCache.clear();
    return { n: acc.n, skip: acc.skip, rules: cfg.rules.length };
  }

  if (data.byWs && typeof data.byWs === 'object' && !Array.isArray(data.byWs)) {
    const ks = Object.keys(data.byWs);
    if (!ks.length) return '备份里没有任何库的数据';
    const next = {};
    for (let i = 0; i < ks.length; i++) {
      const p = data.byWs[ks[i]];
      if (!p || typeof p !== 'object') continue;
      next[ks[i]] = {
        folders: cleanPart(p.folders, acc),
        rules: cleanRules(p.rules, []),
      };
    }
    byWs = next;
    legacyPending = false;
    activateWs(data.last && next[wsKeyOf(data.last)] ? data.last : Object.keys(next)[0]);
  } else {
    if (!data.folders || typeof data.folders !== 'object' || Array.isArray(data.folders)) return '缺少 folders 字段';
    cfg.folders = cleanPart(data.folders, acc);
    cfg.rules = cleanRules(data.rules, cfg.rules);
  }

  reindex();
  regexCache.clear();
  return { n: acc.n, skip: acc.skip, rules: cfg.rules.length };
}

function paintData(host) {
  host.replaceChildren();

  const nFolder = Object.keys(cfg.folders).length;
  const nRule = cfg.rules.length;

  host.appendChild(h('div', 'fi-hint',
    '这里就是你的全部图标设置：哪个文件夹配哪个图标，以及按名称自动配的规则。'
    + '下面显示的是当前这个笔记库的配置，备份时会带上所有库。换电脑或重装插件之前，建议先导出一份。'));

  /* 概览 */
  const sum = h('div', 'fi-sum');
  sum.appendChild(h('span', 'fi-sum-n', String(nFolder)));
  sum.appendChild(h('span', 'fi-label', '个文件夹'));
  sum.appendChild(h('span', 'fi-sum-n', String(nRule)));
  sum.appendChild(h('span', 'fi-label', '条名称规则'));
  host.appendChild(sum);

  /* 记忆范围：多库用户最关心「换个库会不会串」 */
  const wsCount = Object.keys(byWs).length;
  const wsBox = h('div', 'fi-store');
  wsBox.appendChild(h('div', 'fi-store-title', '记忆范围'));
  let wsDesc;
  if (storeMode === 'vault') {
    wsDesc = '每个笔记库的根目录各有一份配置，换库自动换一份，互不影响。';
  } else if (wsDiag.entryWs === true) {
    wsDesc = '按笔记库分开记，已记下 ' + wsCount + ' 个库（当前：' + currentWs + '）。';
  } else if (wsDiag.entryWs === false) {
    wsDesc = '当前客户端没告诉插件「这是哪个库」，多个库可能共用一份设置——'
      + '两边有同名文件夹时会串用图标。要彻底分开，请把存储位置改成「库内文件」。';
  } else {
    wsDesc = '还没在文件树上渲染过，暂时无法判断按库隔离是否生效。已记下 ' + wsCount + ' 个库。';
  }
  wsBox.appendChild(h('div', 'fi-store-desc', wsDesc));
  host.appendChild(wsBox);

  /* 存储位置 */
  const box = h('div', 'fi-store');
  box.appendChild(h('div', 'fi-store-title', '存储位置'));
  const seg = h('div', 'fi-seg');
  const mkSeg = (id, label) => {
    const b = h('button', 'fi-seg-b' + (storeMode === id ? ' on' : ''), label);
    b.addEventListener('click', async () => {
      if (storeMode === id) return;
      const ok = await setStoreMode(id);
      if (!ok) return;
      refreshTree();
      repaintView();
      C.ui.notice(id === 'vault' ? '已改为存在库内文件，会跟着笔记库一起同步' : '已改为存在插件私有存储');
    });
    return b;
  };
  seg.appendChild(mkSeg('plugin', '插件私有存储'));
  seg.appendChild(mkSeg('vault', '库内文件'));
  box.appendChild(seg);

  box.appendChild(h('div', 'fi-store-desc', storeMode === 'vault'
    ? '存在笔记库根目录的 ' + VAULT_FILE + '：跟着库一起同步，重装插件也还在，换设备能带走。'
    : '存在插件自己的数据里，只在这台电脑上。卸载插件会一并删除，换电脑带不走。'));

  host.appendChild(box);

  /* 原始数据 */
  host.appendChild(h('div', 'fi-sub', '原始数据'));
  host.appendChild(h('pre', 'fi-code', snapshotJSON()));

  const bar = h('div', 'fi-actions');
  const cp = h('button', 'fi-btn', '复制');
  cp.title = '复制成文本，粘到哪都能留一份';
  cp.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(snapshotJSON()); C.ui.notice('已复制到剪贴板'); }
    catch (e) { C.ui.notice('复制失败：可直接拖选上面的文本'); }
  });
  bar.appendChild(cp);

  const toVault = h('button', 'fi-btn', '存到库根目录');
  toVault.title = '写一份到 ' + VAULT_FILE + '，不改当前的存储位置';
  toVault.addEventListener('click', async () => {
    const ok = await writeVaultCfg(vaultSnapshot());
    if (ok) C.ui.notice('已保存到库根目录：' + VAULT_FILE);
  });
  bar.appendChild(toVault);

  const dl = h('button', 'fi-btn', '导出文件');
  dl.title = '导出成 .json 文件';
  dl.addEventListener('click', () => {
    try {
      const blob = new Blob([snapshotJSON()], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'folder-icons-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) { /* noop */ } }, 3000);
      C.ui.notice('已导出');
    } catch (e) {
      C.ui.notice('这个环境不让下载，改用「存到库根目录」或「复制」', { kind: 'error' });
    }
  });
  bar.appendChild(dl);

  const reload = h('button', 'fi-btn', '重新读取');
  reload.title = '丢弃界面上的改动，按已保存的数据重读';
  reload.addEventListener('click', async () => {
    await loadCfg();
    refreshTree();
    repaintView();
    C.ui.notice('已重新读取');
  });
  bar.appendChild(reload);
  host.appendChild(bar);

  /* 导入 */
  host.appendChild(h('div', 'fi-sub', '从备份恢复'));
  host.appendChild(h('div', 'fi-hint', '粘贴上面复制的内容，或直接读库根目录里的 ' + VAULT_FILE + '。恢复会覆盖当前全部设置。'));

  const ta = h('textarea', 'fi-code-input');
  ta.placeholder = '把备份的内容粘贴到这里，再点「恢复」';
  host.appendChild(ta);

  const act = h('div', 'fi-actions');
  const imp = h('button', 'fi-btn warn', '恢复');
  imp.addEventListener('click', async () => {
    if (!ta.value.trim()) { C.ui.notice('先粘贴备份内容', { kind: 'error' }); return; }
    const res = importCfg(ta.value);
    if (typeof res === 'string') { C.ui.notice(res, { kind: 'error' }); return; }
    await saveCfg();
    refreshTree();
    repaintView();
    C.ui.notice('已恢复 ' + res.n + ' 项' + (res.skip ? '，跳过 ' + res.skip + ' 项无效' : ''));
  });
  act.appendChild(imp);

  const fromFile = h('button', 'fi-btn', '读库根目录的文件');
  fromFile.addEventListener('click', async () => {
    const data = await readVaultCfg();
    if (!data) { C.ui.notice('库根目录里没有 ' + VAULT_FILE, { kind: 'error' }); return; }
    const res = importCfg(JSON.stringify(data), true);   // 库里的文件只属于这个库
    if (typeof res === 'string') { C.ui.notice(res, { kind: 'error' }); return; }
    await saveCfg();
    refreshTree();
    repaintView();
    C.ui.notice('已从 ' + VAULT_FILE + ' 恢复 ' + res.n + ' 项');
  });
  act.appendChild(fromFile);
  host.appendChild(act);
}


/* ---------------- 主区域视图（总览 / 规则 / 数据） ---------------- */

function repaintView() {
  if (!activeContainer || !activeContainer.isConnected) return;
  paintView(activeContainer);
}

function paintView(container) {
  container.replaceChildren();
  const root = h('div', 'fi-root');

  const top = h('div', 'fi-top');
  const mkTab = (id, label) => {
    const b = h('button', 'fi-tab' + (viewTab === id ? ' on' : ''), label);
    b.addEventListener('click', () => { viewTab = id; paintView(container); });
    return b;
  };
  top.appendChild(mkTab('icons', '总览'));
  top.appendChild(mkTab('rules', '名称规则'));
  top.appendChild(mkTab('data', '数据'));
  root.appendChild(top);

  if (viewTab === 'icons') {
    const pane = h('div', 'fi-pane');
    root.appendChild(pane);
    container.appendChild(root);
    mountIconPane(pane, { compact: false, autofocus: false });
  } else if (viewTab === 'data') {
    const body = h('div', 'fi-body fi-page');
    root.appendChild(body);
    container.appendChild(root);
    paintData(body);
  } else {
    const body = h('div', 'fi-body fi-page');
    root.appendChild(body);
    container.appendChild(root);
    paintRules(body);
  }
}

function openView(tab, path, name) {
  closePopover();
  viewTab = tab || 'icons';
  target = { path: path || '', name: name || (path ? baseOf(path) : '') };
  queryTxt = '';
  if (activeContainer && activeContainer.isConnected) {
    paintView(activeContainer);
    return;
  }
  try { C.views.open(VIEW_ID); } catch (e) { /* noop */ }
  if (activeContainer && activeContainer.isConnected) paintView(activeContainer);
}

/* ---------------- 浮层 ---------------- */

function closePopover() {
  for (let i = 0; i < popCleanup.length; i++) {
    try { popCleanup[i](); } catch (e) { /* noop */ }
  }
  popCleanup = [];
  /* 浮层里的网格被一起销毁，它挂在 document 上的滚动监听要跟着摘掉 */
  if (gridTeardown && gridOwner && popEl && popEl.contains(gridOwner)) gridTeardown();
  if (popEl) {
    try { popEl.remove(); } catch (e) { /* noop */ }
    popEl = null;
  }
  gridOwner = null;
}

function openPopover(path, name) {
  if (!path) { openView('icons'); return; }
  closePopover();

  target = { path: path, name: name || baseOf(path) };
  queryTxt = '';

  const el = h('div', 'fi-pop');

  const head = h('div', 'fi-pop-head');
  const rec = getRec(path);
  head.appendChild(svgEl((rec && rec.icon) || 'image', 15));
  const titles = h('div');
  titles.style.minWidth = '0';
  titles.appendChild(h('div', 'nm', target.name));
  titles.appendChild(h('div', 'sub', target.path));
  head.appendChild(titles);

  const x = h('button', 'x', '×');
  x.title = '关闭（Esc）';
  x.addEventListener('click', closePopover);
  head.appendChild(x);
  el.appendChild(head);

  const pane = h('div', 'fi-pane');
  el.appendChild(pane);
  mountIconPane(pane, {
    compact: true,
    autofocus: true,
    onOpenFull: () => openView('icons', target.path, target.name),
  });

  el.style.visibility = 'hidden';
  document.body.appendChild(el);
  popEl = el;

  /* 光标处定位，越界回夹 */
  const W = el.offsetWidth;
  const H = el.offsetHeight;
  let px = pointer.x;
  let py = pointer.y;
  if (!px && !py) {
    px = Math.round(window.innerWidth / 2 - W / 2);
    py = 140;
  }
  px = Math.max(10, Math.min(px, window.innerWidth - W - 10));
  py = Math.max(10, Math.min(py + 6, window.innerHeight - H - 10));
  el.style.left = px + 'px';
  el.style.top = py + 'px';
  el.style.visibility = '';

  /* 轻关闭：点外部、Esc */
  attachLightClose(el);
}

/** 点外部 / Esc 关闭浮层；同一时刻只允许一个浮层 */
function attachLightClose(el) {
  const onDown = (e) => { if (!el.contains(e.target)) closePopover(); };
  const onKey = (e) => { if (e.key === 'Escape') closePopover(); };
  const tid = setTimeout(() => {
    document.addEventListener('mousedown', onDown, true);
  }, 0);
  document.addEventListener('keydown', onKey, true);
  popCleanup.push(() => {
    clearTimeout(tid);
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
  });
}

/**
 * 名称规则用的图标挑选浮层：挂在按钮下方，选中即回调。
 * 复用 mountIconPane 的搜索 + 滚动续批，避免第二套网格逻辑。
 */
function openPickerAt(anchorEl, curIcon, onPick) {
  closePopover();
  /* 搜索词是全局的，换一处挑选必须重新清空，否则会带着上次的过滤结果 */
  queryTxt = '';
  const el = h('div', 'fi-pop fi-pop-pick');

  const head = h('div', 'fi-pop-head');
  const titles = h('div');
  titles.style.minWidth = '0';
  titles.appendChild(h('div', 'nm', '选择图标'));
  titles.appendChild(h('div', 'sub', '这条规则命中的文件夹都用它'));
  head.appendChild(titles);
  const x = h('button', 'x', '×');
  x.title = '关闭（Esc）';
  x.addEventListener('click', closePopover);
  head.appendChild(x);
  el.appendChild(head);

  const pane = h('div', 'fi-pane');
  el.appendChild(pane);

  el.style.visibility = 'hidden';
  document.body.appendChild(el);
  popEl = el;

  mountIconPane(pane, {
    compact: true,
    autofocus: true,
    pick: {
      icon: curIcon || '',
      onPick: (name) => { closePopover(); onPick(name); },
      onCancel: closePopover,
    },
  });

  /* 贴着按钮定位：优先向下展开，下方明显不够再翻到上方，最后回夹进视口 */
  const W = el.offsetWidth || 440;
  const H = el.offsetHeight || 360;
  const r = anchorEl && anchorEl.getBoundingClientRect ? anchorEl.getBoundingClientRect() : null;
  const vw = window.innerWidth || 1200;
  const vh = window.innerHeight || 800;
  const gap = 6;
  const below = r ? vh - (r.bottom + gap) : vh - 140;
  const above = r ? r.top - gap : 0;
  let px = r ? r.left - 20 : Math.round(vw / 2 - W / 2);
  let py;
  if (!r) py = 140;
  else if (H <= below || below >= above) py = r.bottom + gap;
  else py = r.top - H - gap;
  px = Math.max(8, Math.min(px, vw - W - 8));
  py = Math.max(8, Math.min(py, vh - H - 8));
  el.style.left = px + 'px';
  el.style.top = py + 'px';
  el.style.visibility = '';

  attachLightClose(el);
}

/* ---------------- 入口 ---------------- */

module.exports = {
  async activate(context) {
    C = context;

    injectStyle();
    buildAliasIndex();
    await loadCfg();
    await loadSettings();

    /* 记住右键位置，供浮层定位（fileTreeMenu 的 run 不提供光标坐标） */
    const onCtxMenu = (e) => {
      if (typeof e.clientX === 'number') pointer = { x: e.clientX, y: e.clientY };
    };
    document.addEventListener('contextmenu', onCtxMenu, true);
    C.lifecycle.onUnload(() => {
      document.removeEventListener('contextmenu', onCtxMenu, true);
      closePopover();
    });

    decoHandle = C.ui.decorateFileTree({
      id: 'folder-icons',
      decorate: decorateRow,
    });

    /* 文件树右键 */
    C.ui.fileTreeMenu({
      label: '设置文件夹图标…',
      icon: 'folder-cog',
      when: 'folder',
      run(t) {
        if (!t || !t.path) return;
        if (t.workspaceId) switchWs(t.workspaceId);
        openPopover(t.path, t.name);
      },
    });

    C.ui.fileTreeMenu({
      label: '清除文件夹图标',
      icon: 'folder-x',
      when: 'folder',
      enabled: (t) => {
        if (!t || !t.path) return false;
        return !!(getRec(t.path) || (t.workspaceId && byWs[wsKeyOf(t.workspaceId)]
          && byWs[wsKeyOf(t.workspaceId)].folders[normPath(t.path)]));
      },
      async run(t) {
        if (t.workspaceId) switchWs(t.workspaceId);
        delRec(t.path);
        await saveCfg();
        refreshTree();
        C.ui.notice('已恢复默认图标');
      },
    });

    C.ui.fileTreeMenu({
      label: '文件夹图标总览',
      icon: 'folder-tree',
      when: 'any',
      run(t) {
        if (t && t.workspaceId) switchWs(t.workspaceId);
        openView('icons');
      },
    });

    /* 命令 */
    C.ui.command({
      id: 'open',
      name: '文件夹图标：打开总览',
      run() { openView('icons'); },
    });

    C.ui.command({
      id: 'pick-current',
      name: '文件夹图标：为当前文档所在文件夹设置',
      run() {
        const p = C.active.path();
        if (!p) { C.ui.notice('当前没有打开的文档'); return; }
        const d = dirOf(p);
        if (!d) { C.ui.notice('当前文档在库根目录，没有上级文件夹'); return; }
        openPopover(d, baseOf(d));
      },
    });

    C.ui.command({
      id: 'clear-all',
      name: '文件夹图标：清除全部自定义图标',
      async run() {
        const n = Object.keys(cfg.folders).length;
        if (!n) { C.ui.notice('没有可清除的图标'); return; }
        cfg.folders = {};
        reindex();
        await saveCfg();
        refreshTree();
        repaintView();
        C.ui.notice('已清除 ' + n + ' 个文件夹图标');
      },
    });

    /* 主区域视图 */
    C.views.register({
      id: VIEW_ID,
      name: '文件夹图标',
      icon: 'folder-cog',
      render(container) {
        activeContainer = container;
        paintView(container);
        return () => { if (activeContainer === container) activeContainer = null; };
      },
    });

    /* 设置 */
    C.settings.defineSchema([
      { key: 'enabled', label: '在文件树显示自定义图标', type: 'boolean' },
      { key: 'defaultIcon', label: '文件夹默认图标（Lucide 名称；留空则不装饰未单独设置的文件夹）', type: 'text', placeholder: 'folder' },
      { key: 'badge', label: '统一角标（最多 3 字符，留空不显示）', type: 'text' },
      { key: 'showTooltip', label: '悬停时显示文件夹名', type: 'boolean' },
      { key: 'rulesEnabled', label: '按文件夹名自动配图标（名称规则）', type: 'boolean' },
    ]);

    C.settings.onChange(async () => {
      await loadSettings();
      refreshTree();
      repaintView();
    });

    /* 状态栏 */
    C.ui.statusBar({
      id: 'configured-count',
      text: () => {
        const n = Object.keys(cfg.folders).length;
        return n ? n + ' 个文件夹已设图标' : '';
      },
      title: '文件夹图标 · 点击打开总览',
      onClick: () => openView('icons'),
    });

    /* 文件夹改名/移动 */
    C.vault.on('rename', onRename);

    /* 库内存储模式：别的设备同步过来 / 用户手改了库文件，自动读回 */
    try {
      C.vault.on('modify', onVaultFileTouched);
      C.vault.on('create', onVaultFileTouched);
      C.vault.on('delete', (p) => {
        if (storeMode !== 'vault' || normPath(p) !== VAULT_FILE) return;
        C.ui.notice('库内的 ' + VAULT_FILE + ' 被删除，图标设置仍在本机存储里；下次改动会重新写回', { kind: 'error' });
      });
    } catch (e) { /* 宿主不支持这些事件时静默降级 */ }
  },

  deactivate() {
    closePopover();
    decoHandle = null;
    activeContainer = null;
  },
};
