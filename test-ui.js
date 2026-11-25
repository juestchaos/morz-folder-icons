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
/* 配置落盘是 v3 的分库结构，测试统一用当前库那一份 */
const curCfg = () => {
  const c = store.config;
  if (c && c.byWs) return c.byWs[c.last] || { folders: {}, rules: [] };
  return c || { folders: {}, rules: [] };
};
const vaultFS = {};
const caps = { deco: null, menus: [], views: null, status: [], commands: [], events: {} };

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
  vault: {
    on(evt, cb) { caps.events[evt] = cb; },
    async list() { return []; },
    async exists(p) { return Object.prototype.hasOwnProperty.call(vaultFS, p); },
    async read(p) { return Object.prototype.hasOwnProperty.call(vaultFS, p) ? vaultFS[p] : ''; },
    async create(p, t) { vaultFS[p] = t; return true; },
    async write(p, t) { vaultFS[p] = t; return true; },
  },
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

  /* 1.5) 滚动加载：全屏视图里滚动条在外层容器上，所以监听必须挂 document 捕获阶段 */
  const beforeScroll = cells().length;
  document.dispatchEvent(new dom.window.Event('scroll'));
  await wait(90);
  check('document 上的 scroll 能触发续批', cells().length > beforeScroll,
    beforeScroll + ' → ' + cells().length);

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
  check('配置已写入', (curCfg().folders['notes/项目'] || {}).icon === 'calendar',
    JSON.stringify(curCfg().folders));
  check('选中格有高亮', !!pop.querySelector('.fi-cell.on'));
  check('来源提示改为已单独设置', pop.querySelector('.fi-src') && pop.querySelector('.fi-src').textContent.indexOf('单独设置') >= 0, pop.querySelector('.fi-src') ? pop.querySelector('.fi-src').textContent : 'none');

  const d = caps.deco.decorate({ kind: 'directory', path: 'notes/项目', name: '项目' });
  check('文件树装饰已生效', !!d && d.icon.indexOf('<') === 0);

  /* 3.5) 颜色：只作用于当前文件夹，非法值不落盘 */
  const colIn = () => document.querySelectorAll('.fi-pop .fi-in')[0];
  check('有取色器', !!document.querySelector('.fi-pop .fi-sw'));
  check('颜色输入框提示跟随主题', colIn().placeholder.indexOf('跟随主题') >= 0, colIn().placeholder);

  colIn().value = '不是颜色';
  colIn().dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await wait(60);
  check('非法颜色不落盘',
    !(curCfg().folders['notes/项目'] || {}).color,
    JSON.stringify(curCfg().folders['notes/项目']));
  check('非法颜色标红', colIn().classList.contains('bad'));

  colIn().value = '#60a5fa';
  colIn().dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await wait(80);
  check('合法颜色落盘', (curCfg().folders['notes/项目'] || {}).color === '#60a5fa',
    JSON.stringify(curCfg().folders['notes/项目']));
  const dcol = caps.deco.decorate({ kind: 'directory', path: 'notes/项目', name: '项目' });
  check('装饰带 color', !!dcol && dcol.color === '#60a5fa', JSON.stringify(dcol && dcol.color));
  check('其它文件夹未被污染',
    !(curCfg().folders['Notes/Case'] || {}).color,
    JSON.stringify(curCfg().folders['Notes/Case']));

  colIn().value = '';
  colIn().dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await wait(80);
  const dno = caps.deco.decorate({ kind: 'directory', path: 'notes/项目', name: '项目' });
  check('清空颜色后回到跟随主题', !!dno && !('color' in dno), JSON.stringify(dno));

  /* 恢复成有颜色状态，供后续断言使用 */
  colIn().value = '#60a5fa';
  colIn().dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await wait(60);


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
  check('新增规则写入配置', curCfg().rules.length === 1, JSON.stringify(curCfg().rules));

  /* 9.1) 规则行：图标要能点开挑选，而不是让人手填 lucide 名 */
  const ruleRow = () => ws.querySelector('.fi-row:not(.fi-row-head)');
  check('规则行有可点图标按钮', !!ruleRow().querySelector('.fi-iconbtn'));
  check('规则行有图标名按钮', !!ruleRow().querySelector('.fi-namebtn'));
  check('规则行只剩关键词一个输入框', ruleRow().querySelectorAll('input').length === 1,
    String(ruleRow().querySelectorAll('input').length));
  check('规则行有列头', !!ws.querySelector('.fi-row-head'),
    ws.querySelector('.fi-row-head') ? ws.querySelector('.fi-row-head').textContent : 'none');

  ruleRow().querySelector('.fi-iconbtn').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await wait(80);
  const pickPop = document.querySelector('.fi-pop-pick');
  check('点规则图标弹出挑选浮层', !!pickPop);
  check('挑选浮层挂在 body', pickPop && pickPop.parentElement === document.body);
  check('挑选浮层有搜索框与网格', !!pickPop && !!pickPop.querySelector('.fi-search') && pickPop.querySelectorAll('.fi-cell').length > 0);
  check('挑选浮层不显示文件夹来源行', !!pickPop && !pickPop.querySelector('.fi-src'));
  check('挑选浮层不复用文件夹标题', !!pickPop && !pickPop.querySelector('.fi-target'));

  const rsIn = pickPop.querySelector('.fi-search');
  rsIn.value = 'rocket';
  rsIn.dispatchEvent(new dom.window.Event('input'));
  await wait(260);
  const rocketCell = Array.from(pickPop.querySelectorAll('.fi-cell')).find((b) => b.dataset.name === 'rocket');
  check('搜索能命中 rocket', !!rocketCell);
  rocketCell.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await wait(220);
  check('选中后挑选浮层关闭', !document.querySelector('.fi-pop-pick'));
  check('规则图标已更新', curCfg().rules[0].icon === 'rocket', JSON.stringify(curCfg().rules[0]));
  check('按钮回显新图标名',
    ruleRow().querySelector('.fi-namebtn').textContent.indexOf('rocket') >= 0,
    ruleRow().querySelector('.fi-namebtn').textContent);
  check('规则页重绘后仍停在规则页', !!ws.querySelector('.fi-hint') && !!ruleRow());

  /* 关键词才决定命中范围：只影响名字带它的文件夹 */
  const patIn = ruleRow().querySelector('input');
  patIn.value = '会议';
  patIn.dispatchEvent(new dom.window.Event('input'));
  await wait(140);
  const dHit = caps.deco.decorate({ kind: 'directory', path: 'notes/会议', name: '会议' });
  const dMiss = caps.deco.decorate({ kind: 'directory', path: 'notes/随便', name: '随便' });
  check('规则只套中关键词命中的文件夹',
    !!dHit && dHit.icon.indexOf('<') === 0 && (!dMiss || dHit.icon !== dMiss.icon),
    JSON.stringify([!!dHit, !!dMiss]));

  /* 取消按钮不该改配置 */
  ruleRow().querySelector('.fi-namebtn').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await wait(80);
  const pickPop2 = document.querySelector('.fi-pop-pick');
  check('图标名按钮也能打开挑选浮层', !!pickPop2);
  const cancelBtn = Array.from(pickPop2.querySelectorAll('.fi-btn')).find((b) => b.textContent === '取消');
  check('挑选浮层有取消按钮', !!cancelBtn);
  cancelBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await wait(60);
  check('取消后关闭且不改图标', !document.querySelector('.fi-pop-pick') && curCfg().rules[0].icon === 'rocket',
    JSON.stringify(curCfg().rules[0]));

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
  check('数据页含版本号 v', !!code && code.textContent.indexOf('"v": 3') >= 0);
  const ta = ws.querySelector('.fi-code-input');
  ta.value = JSON.stringify({ folders: { 'a/b': { icon: 'star' }, 'bad': { icon: 'no-such-icon' } } });
  const impBtn = Array.from(ws.querySelectorAll('.fi-btn')).find((b) => b.textContent === '恢复');
  impBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await wait(120);
  check('导入只接受有效条目', !!curCfg().folders['a/b'] && !curCfg().folders['bad'], JSON.stringify(Object.keys(curCfg().folders)));

  /* 12) 数据页文案：不能出现开发话术 */
  const pageText = ws.textContent;
  check('数据页没有 ctx.storage 之类的开发话术',
    pageText.indexOf('ctx.') < 0 && pageText.indexOf('宿主') < 0 && pageText.indexOf('main.js') < 0,
    ['ctx.', '宿主', 'main.js'].filter((k) => pageText.indexOf(k) >= 0).join(','));

  /* 13) 存储位置：默认插件私有，切到库内文件后真的落盘 */
  const segOn = () => (ws.querySelector('.fi-seg-b.on') || {}).textContent;
  check('默认存插件私有存储', segOn() === '插件私有存储', String(segOn()));
  check('未开启时库里没有文件', !Object.keys(vaultFS).length, JSON.stringify(Object.keys(vaultFS)));

  const toVault = Array.from(ws.querySelectorAll('.fi-seg-b')).find((b) => b.textContent === '库内文件');
  toVault.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await wait(160);
  check('切到库内文件后写盘', !!vaultFS['.folder-icons.json'], JSON.stringify(Object.keys(vaultFS)));
  let fileData = null;
  try { fileData = JSON.parse(vaultFS['.folder-icons.json']); } catch (e) { fileData = null; }
  check('库文件是分库结构 v3', !!fileData && fileData.v === 3 && !!fileData.byWs, JSON.stringify(fileData && Object.keys(fileData)));
  check('库文件内容与当前设置一致', !!fileData && JSON.stringify(fileData.byWs).indexOf('a/b') >= 0, String(vaultFS['.folder-icons.json']).slice(0, 80));
  check('切换后选中态更新', segOn() === '库内文件', String(segOn()));

  /* 14) 库内模式下的后续改动要同步进文件 */
  const beforeTxt = vaultFS['.folder-icons.json'];
  menuOf('设置文件夹图标').run({ workspaceId: 'ws1', path: 'x/y', name: 'y' });
  await wait(60);
  document.querySelector('.fi-pop .fi-cell').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await wait(200);
  check('库内模式下改动同步到文件',
    vaultFS['.folder-icons.json'] !== beforeTxt && vaultFS['.folder-icons.json'].indexOf('x/y') >= 0,
    String(vaultFS['.folder-icons.json']).slice(0, 60));
  document.body.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
  await wait(40);

  /* 15) 外部改动库文件（其它设备同步 / 手改）→ 自动读回 */
  vaultFS['.folder-icons.json'] = JSON.stringify({ folders: { 'ext/only': { icon: 'rocket' } }, rules: [] });
  check('已注册库文件改动监听', typeof caps.events.modify === 'function', Object.keys(caps.events).join(','));
  if (caps.events.modify) caps.events.modify('.folder-icons.json');
  await wait(520);
  check('外部改动库文件后自动读回', !!curCfg().folders['ext/only'],
    JSON.stringify(Object.keys(curCfg().folders)));

  /* 16) 「读库根目录的文件」按钮 */
  vaultFS['.folder-icons.json'] = JSON.stringify({ folders: { 'btn/only': { icon: 'star' } }, rules: [] });
  const fromFileBtn = Array.from(ws.querySelectorAll('.fi-btn')).find((b) => b.textContent === '读库根目录的文件');
  check('数据页有「读库根目录的文件」', !!fromFileBtn);
  fromFileBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await wait(150);
  check('从库文件恢复成功', !!curCfg().folders['btn/only'],
    JSON.stringify(Object.keys(curCfg().folders)));

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
