/**
 * 扩展完整性静态校验。
 * 这些错误在浏览器里只表现为「加载失败」或「点了没反应」，事先查出来最划算。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const p = (...segs) => path.join(ROOT, ...segs);
const read = (...segs) => fs.readFileSync(p(...segs), 'utf8');
const exists = (...segs) => fs.existsSync(p(...segs));

const manifest = JSON.parse(read('manifest.json'));

function walkJs(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJs(full, acc);
    else if (entry.name.endsWith('.js')) acc.push(full);
  }
  return acc;
}

/* ---------------- manifest ---------------- */

test('manifest 是合法 MV3 且字段齐全', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.name && manifest.version);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(manifest.action, '需要 action 才能点图标打开侧边栏');
  assert.ok(manifest.side_panel && manifest.side_panel.default_path);
  assert.ok(manifest.background && manifest.background.service_worker);
  assert.equal(manifest.background.type, 'module', '代码用了 ESM，必须声明 type: module');
});

test('manifest 引用的文件全部存在', () => {
  assert.ok(exists(manifest.background.service_worker), 'service worker 文件缺失');
  assert.ok(exists(manifest.side_panel.default_path), '侧边栏页面缺失');

  const icons = Object.values(manifest.icons || {});
  for (const rel of icons) assert.ok(exists(rel), '图标缺失: ' + rel);
  for (const rel of Object.values(manifest.action.default_icon || {})) {
    assert.ok(exists(rel), 'action 图标缺失: ' + rel);
  }
});

test('图标都是合法 PNG 且尺寸正确', () => {
  const expectations = { 'icons/icon16.png': 16, 'icons/icon32.png': 32, 'icons/icon48.png': 48, 'icons/icon128.png': 128 };
  for (const [rel, size] of Object.entries(expectations)) {
    const buf = fs.readFileSync(p(rel));
    assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], rel + ' 不是 PNG');
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    assert.equal(width, size, rel + ' 宽度不符');
    assert.equal(height, size, rel + ' 高度不符');
  }
});

test('声明的权限覆盖代码实际用到的 chrome API', () => {
  const files = walkJs(p('src'));
  const used = new Set();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/chrome\.([a-zA-Z]+)/g)) used.add(m[1]);
  }

  const permissionFor = { sidePanel: 'sidePanel', storage: 'storage', scripting: 'scripting', tabs: 'tabs' };
  for (const [ns, perm] of Object.entries(permissionFor)) {
    if (!used.has(ns)) continue;
    assert.ok(
      (manifest.permissions || []).includes(perm),
      '代码用了 chrome.' + ns + ' 但 manifest 没声明 "' + perm + '" 权限'
    );
  }

  // 反向检查：声明了但没用到的权限（多声明会吓到用户）
  const declared = (manifest.permissions || []).filter((x) => x !== 'activeTab');
  for (const perm of declared) {
    const ns = Object.keys(permissionFor).find((k) => permissionFor[k] === perm);
    if (ns) assert.ok(used.has(ns), '声明了 ' + perm + ' 权限但代码没用到，可以删掉');
  }
});

test('host_permissions 覆盖了脚本注入与外部请求', () => {
  const hosts = manifest.host_permissions || [];
  assert.ok(hosts.includes('<all_urls>'), '读页面正文 + 调 API 需要 <all_urls>');
  // 代码里出现的对外域名都应该被 <all_urls> 覆盖
  const bg = read('src', 'background.js');
  const urls = [...bg.matchAll(/https?:\/\/[a-z0-9.-]+/gi)].map((m) => m[0].toLowerCase());
  for (const u of urls) {
    assert.ok(u.startsWith('http://127.0.0.1') || u.startsWith('https://'), u);
  }
});

/* ---------------- 页面与脚本 ---------------- */

test('侧边栏 HTML 引用的 css/js 都存在', () => {
  const html = read('src', 'sidepanel', 'index.html');
  const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1])
    .filter((r) => !/^(https?:|#|data:)/i.test(r));

  assert.ok(refs.length > 0);
  for (const rel of refs) {
    const target = path.join(ROOT, 'src', 'sidepanel', rel);
    assert.ok(fs.existsSync(target), 'HTML 引用了不存在的文件: ' + rel);
  }
});

test('侧边栏 HTML 不引用任何远程资源（MV3 CSP 会直接拦掉）', () => {
  const html = read('src', 'sidepanel', 'index.html');
  const remote = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(remote, [], '发现远程资源: ' + remote.join(', '));
});

test('app.js 里 $() 用到的 id 都能在 HTML 或动态模板里找到', () => {
  const html = read('src', 'sidepanel', 'index.html');
  const app = read('src', 'sidepanel', 'app.js');

  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  // renderEmptyStateIfNeeded 动态生成的元素
  const dynamicIds = new Set(['empty-state', 'quick-actions']);

  const usedIds = new Set([...app.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  const missing = [...usedIds].filter((id) => !htmlIds.has(id) && !dynamicIds.has(id));

  assert.deepEqual(missing, [], '这些 id 在 HTML 里不存在: ' + missing.join(', '));
});

test('HTML 里的事件相关 class 选择器在 CSS 中有定义', () => {
  const css = read('src', 'sidepanel', 'style.css');
  const required = ['.topbar', '.pagebar', '.messages', '.composer', '.drawer', '.toggle', '.msg-user', '.msg-assistant'];
  for (const sel of required) {
    assert.ok(css.includes(sel), 'CSS 缺少样式: ' + sel);
  }
});

/* ---------------- 模块解析与语法 ---------------- */

test('所有相对 import 都能解析到真实文件', () => {
  const files = walkJs(p('src'));
  let count = 0;
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const target = path.resolve(path.dirname(file), m[1]);
      assert.ok(fs.existsSync(target), path.relative(ROOT, file) + ' 引用了不存在的模块: ' + m[1]);
      count += 1;
    }
  }
  assert.ok(count > 0, '没找到任何 import，检查是不是路径写错');
});

test('所有 JS 文件语法正确（含 service worker 与 UI 脚本）', () => {
  const files = walkJs(p('src'));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-syntax-'));

  try {
    for (const file of files) {
      const tmp = path.join(tmpDir, path.basename(file).replace(/\.js$/, '') + '-' + Math.random().toString(36).slice(2) + '.mjs');
      fs.copyFileSync(file, tmp);
      assert.doesNotThrow(() => {
        execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
      }, path.relative(ROOT, file) + ' 语法错误');
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('service worker 不依赖 DOM（MV3 SW 里没有 DOMParser/document）', () => {
  const bg = read('src', 'background.js');
  const libs = fs.readdirSync(p('src', 'lib')).map((f) => fs.readFileSync(p('src', 'lib', f), 'utf8')).join('\n');
  // extract.js 是注入到页面里跑的，允许用 document；其余库不许
  const nonExtractLibs = fs.readdirSync(p('src', 'lib'))
    .filter((f) => f !== 'extract.js')
    .map((f) => fs.readFileSync(p('src', 'lib', f), 'utf8')).join('\n');

  assert.ok(!/\bDOMParser\b/.test(bg), 'service worker 里不能用 DOMParser');
  assert.ok(!/\bdocument\./.test(bg), 'service worker 里不能用 document');
  assert.ok(!/\bDOMParser\b/.test(nonExtractLibs), '后台共享库不能用 DOMParser');
  assert.ok(!/\bdocument\./.test(nonExtractLibs), '后台共享库不能用 document');
  assert.ok(libs.length > 0);
});

/* ---------------- PDF 支持 ---------------- */

test('pdf.js 运行时资源齐全（含中文 CMap 与标准字体）', () => {
  const must = [
    'vendor/pdfjs/pdf.min.mjs',
    'vendor/pdfjs/pdf.worker.min.mjs',
    // 简体中文
    'vendor/pdfjs/cmaps/Adobe-GB1-UCS2.bcmap',
    'vendor/pdfjs/cmaps/Adobe-GB1-0.bcmap',
    // 繁体中文
    'vendor/pdfjs/cmaps/Adobe-CNS1-UCS2.bcmap',
    'vendor/pdfjs/cmaps/UniCNS-UCS2-H.bcmap',
    // 无嵌入字体时要用
    'vendor/pdfjs/standard_fonts/FoxitSerif.pfb',
    'vendor/pdfjs/standard_fonts/LiberationSans-Regular.ttf',
    'vendor/pdfjs/LICENSE'
  ];
  for (const rel of must) {
    assert.ok(exists(rel), '缺少 pdf.js 资源: ' + rel);
  }

  const cmapDir = p('vendor/pdfjs/cmaps');
  const cmaps = fs.readdirSync(cmapDir);
  assert.ok(cmaps.length >= 100, 'CMap 数量偏少（' + cmaps.length + '），中文 PDF 可能解析失败');
  assert.ok(cmaps.filter((f) => /GB/i.test(f)).length >= 20, '简体中文 CMap 不全');
  assert.ok(cmaps.filter((f) => /CNS/i.test(f)).length >= 10, '繁体中文 CMap 不全');
});

test('pdf-loader 只存在于侧边栏（后台不能碰 pdf.js，SW 没有 DOM）', () => {
  assert.ok(exists('src/sidepanel/pdf-loader.js'), '侧边栏 PDF 加载器缺失');
  const bg = read('src', 'background.js');
  assert.ok(!bg.includes('pdf.min.mjs'), 'service worker 不应该加载 pdf.js');
  assert.ok(!bg.includes('pdf-loader'), 'service worker 不应该引用 pdf-loader');
});

test('后台把 PDF 页面归类为 PDF_DOCUMENT 而不是"读不了"', () => {
  const bg = read('src', 'background.js');
  assert.ok(bg.includes("'PDF_DOCUMENT'"), '缺少 PDF_DOCUMENT 分类');
  assert.ok(/\.pdf\(\\\?\|#\|\$\)/.test(bg) || bg.includes('\\.pdf('), '缺少 PDF URL 识别');
});

test('pdf 依赖体积在可接受范围（不应把整个 wasm/image_decoders 打进来）', () => {
  const dir = p('vendor/pdfjs');
  let total = 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else total += fs.statSync(full).size;
    }
  };
  walk(dir);
  assert.ok(total < 8 * 1024 * 1024, 'vendor/pdfjs 体积 ' + Math.round(total / 1024 / 1024) + 'MB，超了');
  assert.ok(!exists('vendor/pdfjs/wasm'), '不需要 wasm 目录（只取文本）');
});
