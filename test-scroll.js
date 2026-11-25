/**
 * 滚动加载的几何分支测试（jsdom）
 * 用法： NODE_PATH=<jsdom 目录> node test-scroll.js
 *
 * 为什么单开一个文件：这里要手动篡改 getBoundingClientRect / scrollHeight，
 * 会污染同进程里的其它布局断言，所以不并进 test-ui.js。
 * 覆盖的正是「全屏视图滚动加载不生效」的那个场景（用例 C/D）。
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
const caps = { menus: [], views: null };

const ctx = {
  lifecycle: { onUnload() {} },
  storage: {
    async get(k) { return store[k]; },
    async set(k, v) { store[k] = JSON.parse(JSON.stringify(v)); },
  },
  settings: { async get() { return { defaultIcon: '', enabled: true }; }, onChange() {}, defineSchema() {} },
  ui: {
    decorateFileTree(s) { caps.deco = s; return { refresh() {} }; },
    fileTreeMenu(s) { caps.menus.push(s); },
    command() {},
    statusBar() {},
    notice() {},
  },
  views: {
    register(s) { caps.views = s; },
    open() {
      const h = document.getElementById('workspace');
      h.replaceChildren();
      caps.views.render(h, { close() {} });
    },
  },
  vault: { on() {}, async list() { return []; } },
  active: { path: () => 'a.md' },
  timers: { throttle: (f) => f, debounce: (f) => f, setTimeout: (f, ms) => setTimeout(f, ms) },
};

const plugin = require(path.join(__dirname, 'main.js'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const box = (o) => ({ top: 0, left: 0, width: 100, height: 0, right: 100, ...o });
const setRect = (el, o) => { el.getBoundingClientRect = () => box(o); };
const setScroll = (el, sh, ch) => {
  Object.defineProperty(el, 'scrollHeight', { value: sh, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: ch, configurable: true });
};

const results = [];
const check = (n, c, e) => results.push({ n, ok: !!c, e: e || '' });

(async () => {
  await plugin.activate(ctx);

  document.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 200 }));
  caps.menus.find((m) => m.label.indexOf('设置文件夹图标') === 0)
    .run({ workspaceId: 'w', path: 'notes/x', name: 'x' });
  await wait(40);

  const body = document.querySelector('.fi-pop .fi-body');
  const grid = () => document.querySelector('.fi-pop .fi-grid');
  const n = () => document.querySelectorAll('.fi-pop .fi-cell').length;
  const scroll = async () => { document.dispatchEvent(new dom.window.Event('scroll')); await wait(70); };

  global.window.innerHeight = 800;
  check('首批 120 个', n() === 120, String(n()));

  /* A) 容器自身可滚（浮层）：网格底 1100 > 容器底 700+320 → 不该续批 */
  setScroll(body, 3000, 400);
  setRect(body, { bottom: 700, height: 400 });
  setRect(grid(), { bottom: 1100, height: 1100 });
  let a = n();
  await scroll();
  check('A 浮层未接近底部 → 不续批', n() === a, a + ' → ' + n());

  /* B) 容器自身可滚：网格底 950 ≤ 700+320 → 该续批 */
  setRect(grid(), { bottom: 950, height: 950 });
  a = n();
  await scroll();
  check('B 浮层接近底部 → 续批', n() > a, a + ' → ' + n());

  /* C) 外层滚动（全屏视图）：容器不可滚，网格底 2000 远在视口外 → 不该续批 */
  setScroll(body, 2000, 2000);
  setRect(body, { bottom: 2000, height: 2000 });
  setRect(grid(), { bottom: 2000, height: 2000 });
  a = n();
  await scroll();
  check('C 全屏未滚到底 → 不续批', n() === a, a + ' → ' + n());

  /* D) 外层滚动：网格底 900 ≤ 视口 800+320 → 该续批（原 bug 场景） */
  setRect(grid(), { bottom: 900, height: 900 });
  a = n();
  await scroll();
  check('D 全屏滚到底 → 续批', n() > a, a + ' → ' + n());

  /* E) 先滚动加载，再搜索：旧监听必须已被清理，不得串到新网格上 */
  const input = document.querySelector('.fi-pop .fi-search');
  input.value = 'rocket';
  input.dispatchEvent(new dom.window.Event('input'));
  await wait(120);
  const searched = n();
  setScroll(body, 2000, 2000);
  setRect(body, { bottom: 2000, height: 2000 });
  setRect(grid(), { bottom: 900, height: 900 });
  await scroll();
  check('E 换搜索后旧监听不残留（结果已全量渲染）', n() === searched && searched < 120,
    searched + ' → ' + n());

  console.log('');
  let fail = 0;
  for (const r of results) {
    console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.n + (r.e ? '   [' + r.e + ']' : ''));
    if (!r.ok) fail++;
  }
  console.log('');
  console.log(fail ? fail + ' 项失败' : '全部 ' + results.length + ' 项通过');
  process.exit(fail ? 1 : 0);
})();
