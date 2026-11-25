/**
 * 多库（多 workspace）隔离测试
 * 场景：E:\test 与 D:\test 是两个笔记库，里面都有同名的 projects/ 目录。
 * 验证图标不会互相串用，且升级前的旧配置不会丢。
 *
 * 用法： NODE_PATH=<jsdom 目录> node test-multiws.js
 */
'use strict';

const { JSDOM } = require('jsdom');
const path = require('path');

const dom = new JSDOM(
  '<!doctype html><html><head></head><body><div id="workspace"></div></body></html>',
  { pretendToBeVisual: true }
);
global.window = dom.window;
global.document = dom.window.document;
global.DocumentFragment = dom.window.DocumentFragment;
global.Event = dom.window.Event;

const store = {};
const vaultFS = {};
const caps = { deco: null, menus: [], views: null, events: {} };

/* 升级前的老数据：一份扁平配置，没有库的概念 */
store.config = {
  folders: { 'projects/alpha': { icon: 'rocket' } },
  rules: [],
};

const ctx = {
  lifecycle: { onUnload() {} },
  storage: {
    async get(k) { return store[k]; },
    async set(k, v) { store[k] = JSON.parse(JSON.stringify(v)); },
  },
  settings: {
    async get() { return { defaultIcon: '', enabled: true }; },
    onChange() {},
    defineSchema() {},
  },
  ui: {
    decorateFileTree(s) { caps.deco = s; return { refresh() {} }; },
    fileTreeMenu(s) { caps.menus.push(s); },
    command() {},
    statusBar() {},
    notice(m) { console.log('  [notice] ' + m); },
  },
  views: {
    register(s) { caps.views = s; },
    open() {
      const host = document.getElementById('workspace');
      host.replaceChildren();
      caps.views.render(host, { close() {} });
    },
  },
  vault: {
    on(evt, cb) { caps.events[evt] = cb; },
    async list() { return []; },
    async exists(p) { return Object.prototype.hasOwnProperty.call(vaultFS, p); },
    async read(p) { return Object.prototype.hasOwnProperty.call(vaultFS, p) ? vaultFS[p] : ''; },
    async create(p, t) { vaultFS[p] = t; return true; },
    async write(p, t) { vaultFS[p] = t; return true; },
  },
  active: { path: () => 'projects/alpha/a.md' },
  timers: {
    throttle: (f) => f,
    debounce: (f) => f,
    setTimeout: (f, ms) => setTimeout(f, ms),
  },
};

const plugin = require(path.join(__dirname, 'main.js'));

const results = [];
const check = (n, c, e) => results.push({ n, ok: !!c, e: e || '' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const menuOf = (label) => caps.menus.find((m) => m.label.indexOf(label) === 0);

const ROOT_E = 'ws-e-test';
const ROOT_D = 'ws-d-test';

/** 模拟宿主渲染一行文件树；带 workspaceId 时插件应据此切库 */
const rowOf = (ws, p) => caps.deco.decorate({
  kind: 'directory', path: p, name: p.split('/').pop(), workspaceId: ws,
});

(async () => {
  await plugin.activate(ctx);

  /* 1) 旧扁平配置迁移：不丢，且已变成分库结构 */
  check('旧配置未丢失', !!rowOf(ROOT_E, 'projects/alpha'),
    '升级后 projects/alpha 应仍带图标');
  await wait(90);   // 切库后有一次限流落盘
  check('落盘升级为分库结构',
    !!store.config.byWs && store.config.v === 3,
    JSON.stringify(Object.keys(store.config || {})));
  check('旧库标识已换成真实库',
    !!store.config.byWs && !!store.config.byWs[ROOT_E] && !store.config.byWs.default,
    JSON.stringify(Object.keys((store.config && store.config.byWs) || {})));

  /* 2) 换到另一个库：同名路径不应继承上一个库的图标 */
  check('另一库的同名目录不串图标', !rowOf(ROOT_D, 'projects/alpha'),
    'D 库的 projects/alpha 本来没设过图标');

  /* 3) 在 D 库设一个图标 */
  menuOf('设置文件夹图标').run({ workspaceId: ROOT_D, path: 'projects/beta', name: 'beta' });
  await wait(80);
  const cell = document.querySelector('.fi-pop .fi-cell');
  check('浮层已打开', !!cell);
  if (cell) cell.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await wait(200);
  document.body.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
  await wait(60);

  const dIcon = (rowOf(ROOT_D, 'projects/beta') || {}).icon;
  check('D 库设置成功', !!dIcon);

  /* 4) 两个库各自独立：D 有 beta，E 没有；E 有 alpha，D 没有 */
  check('D 库看不到 E 库的 alpha', !rowOf(ROOT_D, 'projects/alpha'));
  check('E 库看不到 D 库的 beta', !rowOf(ROOT_E, 'projects/beta'));
  check('E 库自己的 alpha 还在', !!rowOf(ROOT_E, 'projects/alpha'));

  /* 5) 落盘确实分了两份 */
  const byWs = (store.config && store.config.byWs) || {};
  const keys = Object.keys(byWs);
  check('两个库各存一份', keys.length === 2, JSON.stringify(keys));
  check('E 库只含 alpha',
    keys.length === 2 && !!byWs[ROOT_E].folders['projects/alpha'] && !byWs[ROOT_E].folders['projects/beta'],
    JSON.stringify(keys.map((k) => Object.keys(byWs[k].folders))));
  check('D 库只含 beta',
    keys.length === 2 && !!byWs[ROOT_D].folders['projects/beta'] && !byWs[ROOT_D].folders['projects/alpha'],
    JSON.stringify(keys.map((k) => Object.keys(byWs[k].folders))));

  /* 6) 重启后（重新 activate）仍按库还原 */
  await plugin.activate(ctx);
  const e2 = (rowOf(ROOT_E, 'projects/alpha') || {}).icon;
  const d2 = (rowOf(ROOT_D, 'projects/beta') || {}).icon;
  const x2 = rowOf(ROOT_E, 'projects/beta');
  check('重启后 E 库 alpha 仍在', !!e2);
  check('重启后 D 库 beta 仍在', !!d2);
  check('重启后仍不串库', !x2, 'E 库不该出现 D 库的 beta');

  /* 7) 宿主不给 workspaceId 时退化：沿用最近一次的库（上一步刚渲染过 E 库），不应崩 */
  const noWs = caps.deco.decorate({ kind: 'directory', path: 'projects/alpha', name: 'alpha' });
  check('无 workspaceId 时退化为当前库', !!noWs, '当前库是 E，alpha 应命中');

  /* 8) 数据页把识别结果说清楚 */
  ctx.views.open();
  const tabs = document.querySelectorAll('.fi-tab');
  if (tabs[2]) tabs[2].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await wait(80);
  const txt = document.getElementById('workspace').textContent;
  check('数据页说明记忆范围', txt.indexOf('记忆范围') >= 0, txt.slice(0, 40));
  check('数据页列出按库分开', txt.indexOf('个库') >= 0);

  /* 9) 库内文件模式：文件里记的是别的库名，也要认它自己的键，不能落到空白的 default */
  store.storeMode = 'vault';
  vaultFS['.folder-icons.json'] = JSON.stringify({
    v: 3,
    byWs: { 'ws-v': { folders: { 'v/one': { icon: 'star' } }, rules: [] } },
    last: 'ws-v',
  });
  await plugin.activate(ctx);
  check('库内文件：认自己文件里的库名',
    !!(rowOf('ws-v', 'v/one') || {}).icon,
    'v/one 应命中 star');
  check('库内文件：不把本库配置写给别的库',
    !rowOf(ROOT_E, 'v/one'));

  /* 10) 库内模式下写盘只写当前库那一份，不把其它库的配置带进这个库 */
  let leftE = false;
  try { leftE = vaultFS['.folder-icons.json'].indexOf(ROOT_E) >= 0; } catch (e) { leftE = false; }
  check('库文件不含其它库的数据', !leftE, String(vaultFS['.folder-icons.json']).slice(0, 80));

  /* 输出 */
  console.log('');
  let fail = 0;
  for (const r of results) {
    if (r.ok) console.log('  PASS  ' + r.n + (r.e ? '   [' + r.e + ']' : ''));
    else { fail++; console.log('  FAIL  ' + r.n + '   [' + r.e + ']'); }
  }
  console.log('');
  console.log(fail ? fail + ' 项失败' : '全部 ' + results.length + ' 项通过');
  process.exit(fail ? 1 : 0);
})();
