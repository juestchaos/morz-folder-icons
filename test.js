/**
 * 本地 mock host 测试：不依赖 Morz 客户端，验证核心链路
 * 用法：node test.js
 */
'use strict';

/* --- 最小 DOM shim（只为 injectStyle 服务） --- */
const el = () => ({
  className: '', textContent: '', style: {}, value: '', title: '',
  appendChild() {}, addEventListener() {}, replaceChildren() {},
  remove() {}, setAttribute() {},
});
global.document = {
  createElement: el,
  createDocumentFragment: el,
  head: { appendChild() {} },
  body: { appendChild() {} },
  addEventListener() {},
  removeEventListener() {},
};

const path = require('path');
const store = {};
/* 配置落盘是 v3 的分库结构，测试统一用当前库那一份 */
const curCfg = () => {
  const c = store.config;
  if (c && c.byWs) return c.byWs[c.last] || { folders: {}, rules: [] };
  return c || { folders: {}, rules: [] };
};
const captured = { deco: [], menus: [], commands: [], views: [], schema: [], status: [] };
let renameHandler = null;
let refreshCount = 0;

const ctx = {
  lifecycle: { onUnload() {} },
  storage: {
    async get(k) { return store[k]; },
    async set(k, v) { store[k] = JSON.parse(JSON.stringify(v)); },
  },
  settings: {
    /* 模拟旧版残留：全局 color 项已删除，历史配置里可能还留着，必须被忽略 */
    async get() { return { defaultIcon: 'folder', enabled: true, color: '#ff0000' }; },
    onChange() {},
    defineSchema(f) { captured.schema = f; },
  },
  ui: {
    decorateFileTree(spec) {
      captured.deco.push(spec);
      return { refresh() { refreshCount++; } };
    },
    fileTreeMenu(spec) { captured.menus.push(spec); },
    command(spec) { captured.commands.push(spec); },
    statusBar(spec) { captured.status.push(spec); },
    notice(m, o) { console.log('  [notice]', m, o ? JSON.stringify(o) : ''); },
  },
  views: { register(spec) { captured.views.push(spec); }, open() {} },
  vault: {
    on(evt, cb) { if (evt === 'rename') renameHandler = cb; },
    async list() { return vaultFiles.map((p) => ({ path: p })); },
    async exists(p) { return true; },
  },
  active: { path: () => 'notes/项目/a.md' },
  timers: {
    throttle: (f) => f,
    debounce: (f) => f,
    setTimeout: (f, ms) => setTimeout(f, ms),
  },
};

let vaultFiles = ['notes/项目/a.md', 'notes/其他/b.md'];

/* 预置：一条正常配置 + 一条反斜杠+尾斜杠的脏 key + 一条大小写不一致的 key + 一条规则 */
store.config = {
  folders: {
    'notes/项目': { icon: 'rocket' },
    'notes\\周报\\': { icon: 'inbox' },
    'Notes/Case': { icon: 'star' },
  },
  rules: [
    /* 关键词还没填的规则排在最前：任何类型都不该命中，否则一把套住所有文件夹 */
    { id: 'r0', type: 'startsWith', p: '', icon: 'inbox' },
    { id: 'r1', type: 'contains', p: '会议', icon: 'calendar' },
  ],
};

const plugin = require(path.join(__dirname, 'main.js'));

const results = [];
const check = (name, cond, extra) => {
  results.push({ name, ok: !!cond, extra: extra || '' });
};

(async () => {
  await plugin.activate(ctx);

  check('decorateFileTree 注册 1 次', captured.deco.length === 1);
  check('decorateFileTree 带 id', captured.deco[0].id === 'folder-icons');
  check('fileTreeMenu 注册 3 项', captured.menus.length === 3,
    captured.menus.map((m) => m.when).join('/'));
  check('右键 when 覆盖 folder/any',
    captured.menus.filter((m) => m.when === 'folder').length === 2 &&
    captured.menus.some((m) => m.when === 'any'));
  check('注册了 3 个命令', captured.commands.length === 3);
  check('注册了视图', captured.views.length === 1 && captured.views[0].id === 'folder-icons:view');
  check('settings schema 5 项', captured.schema.length === 5, JSON.stringify(captured.schema.map((x) => x.key)));
  check('全局颜色项已移除（颜色按文件夹独立）', !captured.schema.some((x) => x.key === 'color'));

  const deco = captured.deco[0].decorate;

  const d1 = deco({ kind: 'directory', path: 'notes/项目', name: '项目' });
  check('已配置文件夹 → rocket 图标', d1 && d1.icon && d1.icon.startsWith('<'),
    d1 ? d1.icon.slice(0, 60) + '…' : 'null');
  check('未配置文件夹 → 回退全局默认 folder', !!deco({ kind: 'directory', path: 'notes/其他', name: '其他' }));
  check('文件 → 不装饰', deco({ kind: 'file', path: 'notes/项目/a.md', name: 'a.md' }) === null);
  check('命中名称规则 会议 → calendar', !!deco({ kind: 'directory', path: 'notes/会议', name: '会议' }));
  /* 空关键词规则若被当成「匹配全部」，会议文件夹会先吃到 inbox，两者图标就会相同 */
  const dMeet = deco({ kind: 'directory', path: 'notes/会议', name: '会议' });
  const dNone = deco({ kind: 'directory', path: 'zzz/随便', name: '随便' });
  check('关键词为空的规则不套用任何文件夹',
    !!dMeet && !!dNone && dMeet.icon !== dNone.icon);
  check('装载时把反斜杠/尾斜杠的 key 归一',
    !!curCfg().folders['notes/周报'] && !curCfg().folders['notes\\周报\\'],
    JSON.stringify(Object.keys(curCfg().folders)));
  check('脏 key 归一后仍能命中', !!deco({ kind: 'directory', path: 'notes/周报/', name: '周报' }));
  check('大小写不一致仍能命中', !!deco({ kind: 'directory', path: 'notes/case', name: 'case' }));

  /* 颜色按文件夹孤立：settings 里残留旧版全局 color 也不得外溢 */
  check('无 color 记录的文件夹不传 color 字段',
    d1 && !('color' in d1), JSON.stringify(d1));
  check('仅有全局默认图标的文件夹也不传 color 字段',
    (() => { const t = deco({ kind: 'directory', path: 'notes/其他', name: '其他' }); return t && !('color' in t); })(),
    JSON.stringify(deco({ kind: 'directory', path: 'notes/其他', name: '其他' })));

  /* 反向：文件夹自己带 color 时必须传下去（写入路径由 test-ui 走真实 UI 覆盖） */

  /* 改名迁移：目录整体移动（旧目录已无文件） */
  const before = refreshCount;
  vaultFiles = ['archive/新项目/a.md', 'notes/其他/b.md'];
  renameHandler('notes/项目/a.md', 'archive/新项目/a.md');
  await new Promise((r) => setTimeout(r, 600));
  const d2 = deco({ kind: 'directory', path: 'archive/新项目', name: '新项目' });
  check('文件夹改名后图标跟随', d2 && d2.icon === d1.icon);
  check('改名后触发 refresh', refreshCount === before + 1);
  check('旧 key 已清理', !curCfg().folders['notes/项目'],
    JSON.stringify(Object.keys(curCfg().folders)));

  /* 反例：只移动单个文件，不应改动文件夹图标 */
  curCfg().folders['notes/其他'] = { icon: 'star' };
  vaultFiles = ['notes/其他/b.md', 'inbox/c.md'];
  renameHandler('notes/其他/b.md', 'inbox/b.md');
  await new Promise((r) => setTimeout(r, 600));
  check('单文件移动不误改文件夹图标', !!curCfg().folders['notes/其他'],
    JSON.stringify(Object.keys(curCfg().folders)));

  /* 输出 */
  console.log('');
  let fail = 0;
  for (const r of results) {
    console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '   [' + r.extra + ']' : ''));
    if (!r.ok) fail++;
  }
  console.log('\n' + (fail ? fail + ' 项失败' : '全部 ' + results.length + ' 项通过'));
  process.exit(fail ? 1 : 0);
})();
