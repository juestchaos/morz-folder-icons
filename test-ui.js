/**
 * 浮层 / 视图 UI 测试（jsdom）
 * 用法： NODE_PATH=<jsdom 目录> node test-ui.js
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
const caps = { deco: null, menus: [], views: null, status: [], commands: [] };

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
    command(s) { caps.commands.push(s); },
    statusBar(s) { caps.status.push(s); },
    notice(m) { ctx._last = m; console.log('  [notice] ' + m); },
  },
  views: {
    register(s) { caps.views = s; },
    open() {
      const host = document.getElementById('workspace');
      host.replaceChildren();
      caps.views.render(host, { close() {} });
    },
  },
  vault: { on() {}, async list() { return []; } },
  active: { path: () => 'notes/项目/a.md' },
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

(async () => {
  await plugin.activate(ctx);

  const ws = document.getElementById('workspace');
  const placeholderHTML = ws.innerHTML;

  /* 1) 记录光标位置后触发右键菜单项 */
  document.dispatchEvent(new dom.window.MouseEvent('contextmenu', {
    bubbles: true, clientX: 320, clientY: 240,
  }));
  menuOf('设置文件夹图标').run({ workspaceId: 'ws1', path: 'notes/项目', name: '项目' });
  await wait(30);

  const pop = document.querySelector('.fi-pop');
  check('弹出浮层', !!pop);
  check('浮层挂在 body，不占工作区', pop && pop.parentElement === document.body);
  check('工作区内容未被替换', ws.innerHTML === placeholderHTML);

  const left = parseInt(pop.style.left, 10);
  const top = parseInt(pop.style.top, 10);
  check('浮层定位到光标附近', left === 320 && top > 240 && top < 320, 'left=' + left + ' top=' + top);

  check('浮层有标题与关闭按钮',
    !!pop.querySelector('.fi-pop-head .nm') && !!pop.querySelector('.fi-pop-head .x'));
  check('浮层标题为文件夹名', pop.querySelector('.fi-pop-head .nm').textContent === '项目');
  check('浮层内无 Tab（规则不进浮层）', pop.querySelectorAll('.fi-tab').length === 0);
  check('显示图标来源（未设置）', pop.querySelector('.fi-src') && pop.querySelector('.fi-src').textContent.indexOf('未设置') >= 0, pop.querySelector('.fi-src') ? pop.querySelector('.fi-src').textContent : 'none');

  const cells = () => pop.querySelectorAll('.fi-cell');
  check('网格首批 120 个', cells().length === 120, '实际 ' + cells().length);
  check('每格有 SVG', pop.querySelectorAll('.fi-cell .fi-svg svg').length === cells().length);

  /* 2) 搜索 */
  let input = pop.querySelector('.fi-search');
  input.value = '会议';
  input.dispatchEvent(new dom.window.Event('input'));
  await wait(250);
  check('中文搜索命中较少结果', cells().length > 0 && cells().length < 20, String(cells().length));
  check('"会议"命中 calendar', Array.from(cells()).some((b) => b.dataset.name === 'calendar'),
    Array.from(cells()).slice(0, 5).map((b) => b.dataset.name).join(','));

  /* 3) 点选后保持打开 */
  const calCell = Array.from(cells()).find((b) => b.dataset.name === 'calendar');
  calCell.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await wait(120);
  check('点选后浮层仍打开', !!document.querySelector('.fi-pop'));
  check('配置已写入', (store.config.folders['notes/项目'] || {}).icon === 'calendar',
    JSON.stringify(store.config.folders));
  check('选中格有高亮', !!pop.querySelector('.fi-cell.on'));
  check('来源提示改为已单独设置', pop.querySelector('.fi-src') && pop.querySelector('.fi-src').textContent.indexOf('单独设置') >= 0, pop.querySelector('.fi-src') ? pop.querySelector('.fi-src').textContent : 'none');

  const d = caps.deco.decorate({ kind: 'directory', path: 'notes/项目', name: '项目' });
  check('文件树装饰已生效', !!d && d.icon.indexOf('<') === 0);

  /* 4) 浮层内部点击不应关闭 */
  pop.querySelector('.fi-foot').dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
  await wait(20);
  check('浮层内 mousedown 不关闭', !!document.querySelector('.fi-pop'));

  /* 5) 点外部关闭 */
  document.body.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
  await wait(20);
  check('点外部关闭浮层', !document.querySelector('.fi-pop'));

  /* 6) Esc 关闭 */
  menuOf('设置文件夹图标').run({ workspaceId: 'ws1', path: 'notes/项目', name: '项目' });
  await wait(30);
  check('可再次打开', !!document.querySelector('.fi-pop'));
  check('重开时回显已选图标',
    !!document.querySelector('.fi-cell.on') &&
    document.querySelector('.fi-cell.on').dataset.name === 'calendar');
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(20);
  check('Esc 关闭浮层', !document.querySelector('.fi-pop'));

  /* 7) × 按钮关闭 */
  menuOf('设置文件夹图标').run({ workspaceId: 'ws1', path: 'notes/项目', name: '项目' });
  await wait(30);
  document.querySelector('.fi-pop-head .x').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await wait(20);
  check('× 按钮关闭浮层', !document.querySelector('.fi-pop'));

  /* 8) 完整面板 → 转主区域视图 */
  menuOf('设置文件夹图标').run({ workspaceId: 'ws1', path: 'notes/项目', name: '项目' });
  await wait(30);
  const fullBtn = Array.from(document.querySelectorAll('.fi-pop .fi-btn')).find((b) => b.textContent === '完整面板');
  check('浮层内有「完整面板」', !!fullBtn);
  fullBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await wait(60);
  check('完整面板关闭浮层', !document.querySelector('.fi-pop'));
  check('完整面板打开主区域视图', !!ws.querySelector('.fi-root'));
  check('视图有 3 个 Tab', ws.querySelectorAll('.fi-tab').length === 3, Array.from(ws.querySelectorAll('.fi-tab')).map((b) => b.textContent).join('/'));
  check('视图显示目标路径', ws.querySelector('.fi-target code').textContent === 'notes/项目');

  /* 9) 规则页 */
  const rulesTab = Array.from(ws.querySelectorAll('.fi-tab')).find((b) => b.textContent === '名称规则');
  rulesTab.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await wait(50);
  check('规则页可切换', !!ws.querySelector('.fi-hint'));
  const addBtn = Array.from(ws.querySelectorAll('.fi-btn')).find((b) => /新增规则/.test(b.textContent));
  addBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await wait(80);
  check('新增规则写入配置', store.config.rules.length === 1, JSON.stringify(store.config.rules));

  /* 10) 总览（无目标） */
  menuOf('文件夹图标总览').run({ workspaceId: 'ws1', path: 'notes/项目', name: '项目', kind: 'background' });
  await wait(50);
  check('总览列出已配置文件夹', ws.querySelectorAll('.fi-cell').length === 1);

  /* 11) 数据页：存储内容可见 */
  const dataTab = Array.from(ws.querySelectorAll('.fi-tab')).find((b) => b.textContent === '数据');
  dataTab.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await wait(60);
  const code = ws.querySelector('.fi-code');
  check('数据页展示 JSON', !!code && code.textContent.indexOf('notes/项目') >= 0, code ? code.textContent.slice(0, 40) : 'none');
  check('数据页含版本号 v', !!code && code.textContent.indexOf('"v": 2') >= 0);
  const ta = ws.querySelector('.fi-code-input');
  ta.value = JSON.stringify({ folders: { 'a/b': { icon: 'star' }, 'bad': { icon: 'no-such-icon' } } });
  const impBtn = Array.from(ws.querySelectorAll('.fi-btn')).find((b) => b.textContent === '导入覆盖');
  impBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await wait(120);
  check('导入只接受有效条目', !!store.config.folders['a/b'] && !store.config.folders['bad'], JSON.stringify(Object.keys(store.config.folders)));

  /* 输出 */
  console.log('');
  let fail = 0;
  for (const r of results) {
    console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.n + (r.e ? '   [' + r.e + ']' : ''));
    if (!r.ok) fail++;
  }
  console.log('\n' + (fail ? fail + ' 项失败' : '全部 ' + results.length + ' 项通过'));
  process.exit(fail ? 1 : 0);
})();
