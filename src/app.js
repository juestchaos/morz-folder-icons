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
const VIEW_ID = 'folder-icons:view';

let C = null;                       // ctx
let cfg = { folders: {}, rules: [] };
let ui = {
  enabled: true, defaultIcon: '', color: '', badge: '',
  showTooltip: true, rulesEnabled: true,
};

let decoHandle = null;
let activeContainer = null;         // 主区域视图容器
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

async function loadCfg() {
  let raw = null;
  try { raw = await C.storage.get(STORE_KEY); } catch (e) { raw = null; }
  cfg = {
    folders: (raw && raw.folders && typeof raw.folders === 'object') ? raw.folders : {},
    rules: (raw && Array.isArray(raw.rules)) ? raw.rules : [],
  };
  /* 旧数据可能带反斜杠 / 尾斜杠，装载时统一口径并去重 */
  const clean = {};
  const keys = Object.keys(cfg.folders);
  let dirty = false;
  for (let i = 0; i < keys.length; i++) {
    const k = normPath(keys[i]);
    if (!k || clean[k]) { dirty = true; continue; }
    if (k !== keys[i]) dirty = true;
    clean[k] = cfg.folders[keys[i]];
  }
  cfg.folders = clean;
  reindex();
  regexCache.clear();
  if (dirty) await saveCfg();      // 归一结果落盘，避免每次启动都重算
}

async function saveCfg() {
  try {
    await C.storage.set(STORE_KEY, { v: 2, folders: cfg.folders, rules: cfg.rules });
  } catch (e) {
    C.ui.notice('保存失败：' + (e && e.message ? e.message : e), { kind: 'error' });
  }
}

async function loadSettings() {
  let s = {};
  try { s = (await C.settings.get()) || {}; } catch (e) { s = {}; }
  ui = {
    enabled: s.enabled !== false,
    defaultIcon: typeof s.defaultIcon === 'string' ? s.defaultIcon.trim() : '',
    color: typeof s.color === 'string' ? s.color.trim() : '',
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
      if (p && name.indexOf(p) !== -1) return r.icon;
    }
  }
  return '';
}

function decorateRow(entry) {
  if (!ui.enabled) return null;
  if (!entry || !isDir(entry)) return null;
  const path = normPath(entryPath(entry));
  if (!path) return null;

  const rec = getRec(path);
  const icon = (rec && rec.icon) || ruleIconOf(baseOf(path)) || ui.defaultIcon;
  if (!icon) return null;

  const mark = markOf(icon);
  if (!mark) return null;

  const out = { icon: mark };
  const color = (rec && rec.color) || ui.color;
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
.fi-target{display:flex;gap:8px;align-items:center;padding:0 12px 6px;flex-wrap:wrap}
.fi-target b{font-weight:600}
.fi-target code{padding:2px 6px;border-radius:4px;background:var(--ui-hover,rgba(128,128,128,.15));font-size:12px}
.fi-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(44px,1fr));gap:3px}
.fi-cell{display:flex;align-items:center;justify-content:center;height:40px;border-radius:6px;border:1px solid transparent;background:none;color:inherit;cursor:pointer;position:relative;padding:0}
.fi-cell:hover{background:var(--ui-hover,rgba(128,128,128,.15))}
.fi-cell.on{border-color:var(--primary-color,#60a5fa);background:var(--ui-hover,rgba(128,128,128,.15))}
.fi-cell .fi-name{position:absolute;bottom:0;left:0;right:0;text-align:center;font-size:8px;opacity:.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fi-empty{padding:22px 10px;text-align:center;opacity:.6;font-size:12px}
.fi-foot{display:flex;gap:6px;align-items:center;padding:8px 12px;border-top:1px solid var(--background-modifier-border,#333);flex-wrap:wrap}
.fi-btn{padding:4px 10px;border-radius:6px;border:1px solid var(--background-modifier-border,#333);background:none;color:inherit;font:inherit;font-size:12px;cursor:pointer}
.fi-btn:hover{background:var(--ui-hover,rgba(128,128,128,.15))}
.fi-btn.warn{color:#f87171;border-color:#7f1d1d}
.fi-in{width:84px;padding:4px 8px;border-radius:6px;border:1px solid var(--background-modifier-border,#333);background:var(--ui-bg,transparent);color:inherit;font:inherit;font-size:12px}
.fi-label{opacity:.6;font-size:11px}
.fi-row{display:grid;grid-template-columns:34px 92px 1fr 92px auto;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--background-modifier-border,#2a2a2a)}
.fi-row select{padding:4px 6px;border-radius:6px;border:1px solid var(--background-modifier-border,#333);background:var(--ui-bg,transparent);color:inherit;font:inherit;font-size:12px}
.fi-hint{opacity:.55;font-size:12px;line-height:1.7;margin:6px 0 10px}
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
.fi-pop{position:fixed;z-index:9999;width:396px;max-height:min(72vh,540px);display:flex;flex-direction:column;
  background:var(--ui-bg,var(--background-primary,#232326));color:var(--text-color,#ddd);
  border:1px solid var(--background-modifier-border,#3a3a3c);border-radius:10px;
  box-shadow:0 18px 48px rgba(0,0,0,.5);overflow:hidden;font-size:13px}
.fi-pop-head{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--background-modifier-border,#3a3a3c)}
.fi-pop-head .nm{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fi-pop-head .sub{font-size:11px;opacity:.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fi-pop-head .x{margin-left:auto;flex:none;border:0;background:none;color:inherit;cursor:pointer;
  font-size:16px;line-height:1;padding:3px 7px;border-radius:5px;opacity:.55}
.fi-pop-head .x:hover{opacity:1;background:var(--ui-hover,rgba(128,128,128,.15))}
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
  if (!opts.compact && target.path) {
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
    if (!target.path) return;
    const src = sourceOf(target.path);
    const line = h('div', 'fi-src');
    line.appendChild(h('span', 'fi-dot ' + src.kind));
    if (src.icon) line.appendChild(svgEl(src.icon, 13));
    line.appendChild(h('span', null, src.text));
    srcHost.appendChild(line);
  }
  renderSrc();

  /* 无目标 → 已配置总览 */
  if (!target.path) {
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
      b.appendChild(svgEl(rec.icon, 18));
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

  let selected = (getRec(target.path) || {}).icon || '';

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
        b.appendChild(svgEl(name, opts.compact ? 16 : 18));
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

    body.onscroll = C.timers.throttle(() => {
      if (shown >= list.length) return;
      if (body.scrollTop + body.clientHeight >= body.scrollHeight - 160) batch();
    }, 80);
  }

  async function applyIcon(name) {
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
    const rec = getRec(target.path);

    foot.appendChild(h('span', 'fi-label', '颜色'));
    const col = h('input', 'fi-in');
    col.placeholder = ui.color || '跟随主题';
    col.value = (rec && rec.color) || '';
    foot.appendChild(col);

    foot.appendChild(h('span', 'fi-label', '角标'));
    const bdg = h('input', 'fi-in');
    bdg.style.width = '46px';
    bdg.placeholder = ui.badge || '无';
    bdg.maxLength = 3;
    bdg.value = (rec && rec.badge) || '';
    foot.appendChild(bdg);

    const saveBtn = h('button', 'fi-btn', '保存样式');
    saveBtn.addEventListener('click', async () => {
      const cur = getRec(target.path);
      if (!cur) { C.ui.notice('请先选择一个图标'); return; }
      const c = col.value.trim(), b = bdg.value.trim();
      if (c) cur.color = c; else delete cur.color;
      if (b) cur.badge = b.slice(0, 3); else delete cur.badge;
      await saveCfg();
      refreshTree();
      C.ui.notice('样式已保存');
    });
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

  host.appendChild(h('div', 'fi-hint',
    '按文件夹名称匹配，自上而下取第一条命中。优先级：单独设置的图标 ＞ 名称规则 ＞ 全局默认图标。'));

  const addBtn = h('button', 'fi-btn', '+ 新增规则');
  addBtn.addEventListener('click', async () => {
    cfg.rules.push({ id: 'r' + Date.now(), type: 'contains', p: '', icon: 'folder' });
    await saveCfg();
    refreshTree();
    paintRules(host);
  });
  host.appendChild(addBtn);

  if (!cfg.rules.length) {
    host.appendChild(h('div', 'fi-empty', '暂无规则。'));
    return;
  }

  const wrap = h('div');
  cfg.rules.forEach((r, idx) => {
    const row = h('div', 'fi-row');
    row.appendChild(svgEl(r.icon, 16));

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

    const icon = h('input', 'fi-in');
    icon.placeholder = 'lucide 名';
    icon.value = r.icon || '';
    icon.addEventListener('input', C.timers.debounce(async () => {
      const v = icon.value.trim();
      if (v && !LUCIDE[v]) { C.ui.notice('未知图标名：' + v, { kind: 'error' }); return; }
      r.icon = v;
      await saveCfg(); refreshTree(); paintRules(host);
    }, 300));
    row.appendChild(icon);

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
  return JSON.stringify({ v: 2, folders: cfg.folders, rules: cfg.rules }, null, 2);
}

/** 导入：只接受形状正确且图标名真实存在的条目，其余跳过并计数 */
function importCfg(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { return 'JSON 解析失败：' + (e && e.message ? e.message : e); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return '顶层必须是一个对象';
  const src = (data.folders && typeof data.folders === 'object' && !Array.isArray(data.folders)) ? data.folders : null;
  if (!src) return '缺少 folders 字段';

  const folders = {};
  let n = 0;
  let skip = 0;
  Object.keys(src).forEach((k) => {
    const p = normPath(k);
    const r = src[k];
    if (!p || !r || typeof r !== 'object' || typeof r.icon !== 'string' || !LUCIDE[r.icon]) { skip++; return; }
    const out = { icon: r.icon };
    if (typeof r.color === 'string' && r.color) out.color = r.color;
    if (typeof r.badge === 'string' && r.badge) out.badge = r.badge.slice(0, 3);
    folders[p] = out;
    n++;
  });
  const rules = Array.isArray(data.rules)
    ? data.rules.filter((r) => r && typeof r.p === 'string' && typeof r.icon === 'string' && LUCIDE[r.icon]).slice(0, 8)
    : cfg.rules;

  cfg.folders = folders;
  cfg.rules = rules;
  reindex();
  regexCache.clear();
  return { n: n, skip: skip, rules: rules.length };
}

function paintData(host) {
  host.appendChild(h('div', 'fi-hint',
    '这一页就是插件记下的全部内容：文件夹路径 → 图标记录。它存在宿主的插件私有存储（ctx.storage，键 config）里，'
    + '不在笔记里，也不在 main.js 里；宿主未公开具体落盘路径，卸载插件时会一并删掉。'));

  host.appendChild(h('pre', 'fi-code', snapshotJSON()));

  const bar = h('div', 'fi-actions');
  const cp = h('button', 'fi-btn', '复制 JSON');
  cp.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(snapshotJSON()); C.ui.notice('已复制到剪贴板'); }
    catch (e) { C.ui.notice('复制失败：可直接拖选上面的文本'); }
  });
  bar.appendChild(cp);
  const reload = h('button', 'fi-btn', '重新读自存储');
  reload.addEventListener('click', async () => {
    await loadCfg();
    refreshTree();
    repaintView();
    C.ui.notice('已从存储重新读取');
  });
  bar.appendChild(reload);
  host.appendChild(bar);

  const ta = h('textarea', 'fi-code-input');
  ta.placeholder = '把备份的 JSON 粘贴到这里，再点「导入覆盖」';
  host.appendChild(ta);

  const imp = h('button', 'fi-btn', '导入覆盖');
  imp.addEventListener('click', async () => {
    const res = importCfg(ta.value);
    if (typeof res === 'string') { C.ui.notice(res, { kind: 'error' }); return; }
    await saveCfg();
    refreshTree();
    repaintView();
    C.ui.notice('已导入 ' + res.n + ' 项' + (res.skip ? '，跳过 ' + res.skip + ' 项无效' : ''));
  });
  host.appendChild(imp);
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
    const body = h('div', 'fi-body');
    root.appendChild(body);
    container.appendChild(root);
    paintData(body);
  } else {
    const body = h('div', 'fi-body');
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
  if (popEl) {
    try { popEl.remove(); } catch (e) { /* noop */ }
    popEl = null;
  }
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
        openPopover(t.path, t.name);
      },
    });

    C.ui.fileTreeMenu({
      label: '清除文件夹图标',
      icon: 'folder-x',
      when: 'folder',
      enabled: (t) => !!(t && getRec(t.path)),
      async run(t) {
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
      run() { openView('icons'); },
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
      { key: 'color', label: '图标颜色（CSS 颜色或主题变量，留空跟随主题）', type: 'text', placeholder: 'var(--primary-color)' },
      { key: 'badge', label: '统一角标（最多 3 字符，留空不显示）', type: 'text' },
      { key: 'showTooltip', label: '悬停时显示文件夹名', type: 'boolean' },
      { key: 'rulesEnabled', label: '启用名称规则', type: 'boolean' },
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
  },

  deactivate() {
    closePopover();
    decoHandle = null;
    activeContainer = null;
  },
};
