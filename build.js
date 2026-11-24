/**
 * 构建脚本：把图标数据 + 别名 + 业务代码合并成单文件 main.js
 * Morz 插件不支持 import / require，发布物必须是单个 CommonJS 文件。
 *
 * 用法：node build.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = __dirname;
const read = (p) => fs.readFileSync(path.join(dir, p), 'utf8');

const manifest = JSON.parse(read('manifest.json'));
const icons = read('src/lucide-icons.json');
const alias = read('src/zh-aliases.json');
const app = read('src/app.js');

const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
const header =
  '/*! ' + manifest.name + ' v' + manifest.version + ' — built ' + stamp + ' */\n';

// 图标数据作为只读全局注入；业务代码包进 IIFE，避免污染宿主全局
const out =
  header +
  'var LUCIDE=' + icons + ';\n' +
  'var ZH_ALIAS=' + alias + ';\n' +
  '(function(){\n' + app + '\n})();\n';

// 语法校验
try {
  new vm.Script(out, { filename: 'main.js' });
} catch (e) {
  console.error('构建失败（语法错误）：' + e.message);
  process.exit(1);
}

fs.writeFileSync(path.join(dir, 'main.js'), out);

const kb = (Buffer.byteLength(out) / 1024).toFixed(1);
console.log('main.js 已生成  ' + kb + ' KB  （图标 ' +
  Object.keys(JSON.parse(icons)).length + ' 个，中文别名 ' +
  Object.keys(JSON.parse(alias)).length + ' 组）');
