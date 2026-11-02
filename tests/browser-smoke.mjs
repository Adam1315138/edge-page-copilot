/**
 * 真实 Edge 冒烟测试（不属于 --test 套件，需要联网和本机 Edge）。
 *
 *   NODE_PATH=<含 playwright-core 的 node_modules> node tests/browser-smoke.mjs
 *
 * 验证的是单测碰不到的东西：
 *   1. manifest 能被 Edge 真正接受（加载失败会在这里暴露）
 *   2. service worker 能启动
 *   3. 侧边栏页面能渲染、CSS 生效、关键元素都在
 *   4. 正文提取函数在真实 Chrome DOM 环境里能跑（不是只有 jsdom 能跑）
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT_DIR = path.join(ROOT, 'dist');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const log = (ok, msg) => console.log((ok ? '  [PASS] ' : '  [FAIL] ') + msg);
let failures = 0;
function check(cond, msg, extra) {
  if (cond) log(true, msg);
  else {
    failures += 1;
    log(false, msg + (extra ? ' —— ' + extra : ''));
  }
}

/** 起个本地 http 服务托管测试 PDF，避免依赖外网；extraFiles 可挂临时文件 */
function startFixtureServer(extraFiles = {}) {
  const root = path.join(ROOT, 'tests', 'fixtures');

  const server = http.createServer((req, res) => {
    const name = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '');
    if (!name) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }

    const full = extraFiles[name] || path.join(root, name);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }

    const stat = fs.statSync(full);
    const type = /\.pdf$/i.test(name) ? 'application/pdf' : 'text/plain; charset=utf-8';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes'
    });
    fs.createReadStream(full).pipe(res);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((r) => {
          server.closeAllConnections();
          server.close(() => r());
        })
      });
    });
  });
}

async function main() {
  if (!fs.existsSync(EDGE)) {
    console.error('找不到 Edge: ' + EDGE);
    process.exit(2);
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-edge-'));
  console.log('加载扩展目录: ' + ROOT + '\n');

  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: EDGE,
    headless: true,
    args: [
      '--disable-extensions-except=' + ROOT,
      '--load-extension=' + ROOT,
      '--no-first-run',
      '--no-default-browser-check'
    ]
  });

  try {
    // ---- 1. service worker 是否启动（能启动就说明 manifest 被接受）----
    let workers = context.serviceWorkers();
    if (workers.length === 0) {
      try {
        workers = [await context.waitForEvent('serviceworker', { timeout: 15000 })];
      } catch (e) {
        workers = context.serviceWorkers();
      }
    }
    check(workers.length > 0, 'service worker 已启动');

    let extensionId = '';
    for (const w of workers) {
      const m = w.url().match(/^chrome-extension:\/\/([a-z]+)\//);
      if (m) { extensionId = m[1]; break; }
    }
    check(!!extensionId, '拿到扩展 ID: ' + extensionId);
    if (!extensionId) throw new Error('扩展没加载成功，后续测试无法进行');

    // ---- 2. manifest 内容被浏览器正确解析 ----
    const page = await context.newPage();
    const sidePanelUrl = 'chrome-extension://' + extensionId + '/src/sidepanel/index.html';
    await page.goto(sidePanelUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(600);

    const manifestInfo = await page.evaluate(() => {
      const m = chrome.runtime.getManifest();
      return {
        name: m.name,
        version: m.version,
        mv: m.manifest_version,
        hasSidePanel: typeof chrome.sidePanel === 'object',
        hasScripting: typeof chrome.scripting === 'object',
        hasStorageSession: !!(chrome.storage && chrome.storage.session)
      };
    });
    check(manifestInfo.mv === 3, 'manifest_version = 3');
    check(manifestInfo.name.includes('Page Copilot'), '扩展名: ' + manifestInfo.name);
    check(manifestInfo.hasSidePanel, 'chrome.sidePanel API 可用');
    check(manifestInfo.hasScripting, 'chrome.scripting API 可用');
    check(manifestInfo.hasStorageSession, 'chrome.storage.session 可用');

    // ---- 3. UI 渲染 ----
    const ui = await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const qa = (s) => document.querySelectorAll(s).length;
      const dot = q('#status-dot');
      const composer = q('.composer');
      return {
        brand: !!q('.brand-name'),
        input: !!q('#input'),
        sendBtn: !!q('#btn-send'),
        toggles: qa('.toggle'),
        drawer: !!q('#drawer'),
        quickCount: qa('.quick'),
        composerBg: composer ? getComputedStyle(composer).backgroundColor : '',
        bodyFont: getComputedStyle(document.body).fontFamily,
        dotClass: dot ? dot.className : ''
      };
    });
    check(ui.brand, '顶栏渲染');
    check(ui.input, '输入框渲染');
    check(ui.sendBtn, '发送按钮渲染');
    check(ui.toggles === 2, '两个上下文开关（页面 / 联网），实际 ' + ui.toggles);
    check(ui.drawer, '设置抽屉存在');
    check(ui.quickCount >= 4, '快捷动作至少 4 个，实际 ' + ui.quickCount);
    check(ui.composerBg !== 'rgba(0, 0, 0, 0)', 'CSS 生效（composer 有背景色）', ui.composerBg);
    check(/PingFang|Microsoft YaHei|system-ui|Segoe/.test(ui.bodyFont), '字体栈生效', ui.bodyFont);

    // ---- 4. 控制台错误检查 ----
    const consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    const realErrors = consoleErrors.filter((e) => !/favicon|net::ERR_FILE/i.test(e));
    check(realErrors.length === 0, '侧边栏无 JS 报错', realErrors.join(' | '));

    // 截图留档（主界面 / 设置面板各一张）
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    await page.setViewportSize({ width: 400, height: 720 });
    await page.evaluate(() => {
      const d = document.getElementById('drawer');
      const m = document.getElementById('drawer-mask');
      if (d) d.hidden = true;
      if (m) m.hidden = true;
    });
    await page.screenshot({ path: path.join(SHOT_DIR, 'ui-main.png') });
    await page.evaluate(() => {
      const d = document.getElementById('drawer');
      const m = document.getElementById('drawer-mask');
      if (d) d.hidden = false;
      if (m) m.hidden = false;
    });
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(SHOT_DIR, 'ui-settings.png') });
    log(true, '截图: dist/ui-main.png, dist/ui-settings.png');

    // ---- 5. 提取函数在真实浏览器环境执行（用 addScriptTag，等同页面内注入）----
    const realPage = await context.newPage();
    await realPage.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await realPage.waitForTimeout(300);

    const extractSrc = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'extract.js'), 'utf8');
    const fnBody = extractSrc.replace(/^export\s+function\s+extractPageContext/m, 'function extractPageContext');
    await realPage.addScriptTag({ content: fnBody + '\nwindow.__pc_extract = extractPageContext;' });
    const extractResult = await realPage.evaluate(() => window.__pc_extract({ maxChars: 5000 }));

    check(extractResult.ok === true, '真实页面提取成功');
    check(extractResult.title.length > 0, '标题: ' + extractResult.title);
    check(extractResult.hasLayout === true, '真实浏览器有布局信息（视口判断生效）');
    check(extractResult.charCount > 30, '正文字数 ' + extractResult.charCount);
    check(/example/i.test(extractResult.mainText), '正文含关键词');

    // ---- 6. 走正式链路：sidepanel → port → background → chrome.scripting 注入 ----
    // 让 example.com 成为活动标签页，侧边栏页面退到后台
    await realPage.bringToFront();
    await realPage.waitForTimeout(200);

    const injected = await page.evaluate(() => new Promise((resolve) => {
      const port = chrome.runtime.connect({ name: 'page-copilot' });
      const timer = setTimeout(() => {
        try { port.disconnect(); } catch (e) { /* ignore */ }
        resolve({ error: '10s 超时没收到 page:info' });
      }, 10000);

      port.onMessage.addListener((msg) => {
        if (msg && msg.type === 'page:info') {
          clearTimeout(timer);
          try { port.disconnect(); } catch (e) { /* ignore */ }
          resolve(msg.info);
        }
      });
      port.postMessage({ type: 'page:get' });
    }));

    check(!injected.error, '端口链路连通（sidepanel → background）', injected.error || '');
    check(injected.ok === true, '通过 chrome.scripting 真实注入并提取到正文，' + injected.charCount + ' 字',
      'reason=' + injected.reason + ' msg=' + injected.message);
    check(/Example Domain/i.test(injected.title || ''), '抓到的是活动标签页: ' + injected.title);

    // ---- 7. PDF 场景：真实文档解析（重点）----
    // 现场用 Chromium 生成一份中文 PDF：中文才是用户的主场景，必须真的验证一遍
    const cnPdfPath = path.join(os.tmpdir(), 'pc-cn-fixture-' + Date.now() + '.pdf');
    let cnGenerated = false;
    try {
      const genPage = await context.newPage();
      await genPage.setContent(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>
        body { font-family: "Microsoft YaHei","SimSun",sans-serif; font-size: 13pt; line-height: 1.9; padding: 48px; }
        h1 { font-size: 20pt; } h2 { font-size: 15pt; }
      </style></head><body>
        <h1>中文 PDF 解析测试文档</h1>
        <p>这是一份用于验证中文文本提取的测试文档。深度学习模型的推理成本主要由注意力机制的计算量决定，因此在长文本场景下需要采用稀疏注意力或分块缓存策略。</p>
        <p>第二段：本节讨论大语言模型的上下文窗口管理。当输入超过窗口长度时，常见做法是滑动窗口、摘要压缩或检索增强生成。</p>
        <h2>验证要点</h2>
        <ul>
          <li>中文标点，。！？必须正确还原</li>
          <li>数字 123456 与英文 mixed text 需要混排正确</li>
          <li>换行不应把中文词语拆开</li>
        </ul>
      </body></html>`, { waitUntil: 'domcontentloaded' });
      await genPage.waitForTimeout(300);
      await genPage.pdf({ path: cnPdfPath, format: 'A4', printBackground: false });
      await genPage.close();
      cnGenerated = fs.existsSync(cnPdfPath) && fs.statSync(cnPdfPath).size > 1000;
      if (cnGenerated) console.log('\n[PDF] 已生成中文 fixture: ' + Math.round(fs.statSync(cnPdfPath).size / 1024) + 'KB');
      else console.log('\n[PDF] 中文 fixture 生成失败（文件过小）');
    } catch (e) {
      console.log('\n[PDF] 中文 fixture 生成异常: ' + e.message);
    }

    const fixture = await startFixtureServer(cnGenerated ? { 'cn.pdf': cnPdfPath } : {});
    try {
      const pdfUrl = 'http://127.0.0.1:' + fixture.port + '/test.pdf';
      const pdfTab = await context.newPage();
      await pdfTab.goto(pdfUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await pdfTab.bringToFront();
      await pdfTab.waitForTimeout(1200);
      console.log('\n[PDF] 已在 Edge 中打开 ' + pdfUrl + '（tab url = ' + pdfTab.url() + '）');

      // 后台是否把这一页判为 PDF —— 依赖 tab.url，所以先看真实浏览器里 url 长什么样
      const bgInfo = await page.evaluate(() => new Promise((resolve) => {
        const port = chrome.runtime.connect({ name: 'page-copilot' });
        const timer = setTimeout(() => {
          try { port.disconnect(); } catch (e) { /* ignore */ }
          resolve({ error: '15s 超时' });
        }, 15000);
        port.onMessage.addListener((msg) => {
          if (msg && msg.type === 'page:info') {
            clearTimeout(timer);
            try { port.disconnect(); } catch (e) { /* ignore */ }
            resolve(msg.info);
          }
        });
        port.postMessage({ type: 'page:get' });
      }));

      check(!bgInfo.error, 'PDF 页拿到 page:info', bgInfo.error || '');
      check(bgInfo.reason === 'PDF_DOCUMENT', '后台把它判为 PDF（reason=' + bgInfo.reason + ', url=' + bgInfo.url + '）');
      check(/\.pdf/i.test(bgInfo.url || ''), '后台看到的是 PDF 原始地址: ' + bgInfo.url);

      // 直接调 PDF 解析器，验证真实文档能出文本
      const pdfCtx = await page.evaluate(async (url) => {
        const mod = await import('./pdf-loader.js');
        const t0 = Date.now();
        try {
          const ctx = await mod.loadPdfContext(url, { maxChars: 24000 });
          return {
            ok: ctx.ok,
            pageCount: ctx.pageCount,
            pagesRead: ctx.pagesRead,
            charCount: ctx.charCount,
            rawCharCount: ctx.rawCharCount,
            title: ctx.title,
            truncated: ctx.truncated,
            elapsed: Date.now() - t0,
            hasPageMarkers: /\[第 \d+ 页\]/.test(ctx.mainText),
            sample: String(ctx.mainText || '').slice(0, 400)
          };
        } catch (e) {
          return { error: (e && e.name ? e.name + ': ' : '') + (e && e.message ? e.message : String(e)) };
        }
      }, pdfUrl);

      check(!pdfCtx.error, 'pdf.js 解析成功（耗时 ' + (pdfCtx.elapsed || 0) + 'ms）', pdfCtx.error || '');
      if (!pdfCtx.error) {
        check(pdfCtx.ok === true, '解析结果 ok=true');
        check(pdfCtx.pageCount === 14, '页数 = 14，实际 ' + pdfCtx.pageCount);
        check(pdfCtx.charCount > 12000, '提取到 ' + pdfCtx.charCount + ' 字符（原始 ' + pdfCtx.rawCharCount + '）');
        check(pdfCtx.hasPageMarkers === true, '正文带 [第 N 页] 页码标记');
        check(/trace|javascript|dynamic language/i.test(pdfCtx.sample),
          '正文内容对得上（不是乱码/空白）');
        console.log('  [INFO] 文档标题: ' + pdfCtx.title);
        console.log('  [INFO] 正文开头: ' + JSON.stringify(pdfCtx.sample.slice(0, 160)));
      }

      // UI 是否自动解析（切到 PDF 后侧边栏应自己开始解析并显示页数）
      await pdfTab.bringToFront();
      await page.waitForTimeout(8000);
      const pdfUi = await page.evaluate(() => ({
        title: (document.getElementById('page-title') || {}).textContent || '',
        meta: (document.getElementById('page-meta') || {}).textContent || '',
        dot: (document.getElementById('status-dot') || {}).className || ''
      }));
      check(/14\s*页/.test(pdfUi.meta), 'UI 自动解析并显示页数，实际 meta="' + pdfUi.meta + '"');
      check(pdfUi.dot.includes('ok'), '状态灯为正常态');
      console.log('  [INFO] 页面条: ' + pdfUi.title + ' | ' + pdfUi.meta);

      // ---- 8. 中文 PDF（用户主场景）----
      if (cnGenerated) {
        const cnUrl = 'http://127.0.0.1:' + fixture.port + '/cn.pdf';
        const cnCtx = await page.evaluate(async (url) => {
          const mod = await import('./pdf-loader.js');
          try {
            const ctx = await mod.loadPdfContext(url, { maxChars: 24000 });
            return {
              ok: ctx.ok,
              pageCount: ctx.pageCount,
              charCount: ctx.charCount,
              title: ctx.title,
              sample: String(ctx.mainText || '').slice(0, 400)
            };
          } catch (e) {
            return { error: (e && e.name ? e.name + ': ' : '') + (e && e.message ? e.message : String(e)) };
          }
        }, cnUrl);

        check(!cnCtx.error, '中文 PDF 解析成功', cnCtx.error || '');
        if (!cnCtx.error) {
          check(cnCtx.charCount > 100, '中文 PDF 提取到 ' + cnCtx.charCount + ' 字符');
          check(/中文\s*PDF|深度学习|注意力机制|上下文窗口/.test(cnCtx.sample),
            '中文内容正确还原（不是乱码/方框）');
          check(!/[\ufffd]/.test(cnCtx.sample), '没有替换字符（U+FFFD）');
          console.log('  [INFO] 中文 PDF 标题: ' + cnCtx.title);
          console.log('  [INFO] 中文 PDF 正文: ' + JSON.stringify(cnCtx.sample.slice(0, 200)));
        }
      } else {
        console.log('  [SKIP] 中文 PDF 未验证（fixture 生成失败）');
      }

      // ---- 8.5 页码定位：预算不足时「问第 N 页」必须带上该页（核心回归）----
      const pageSelect = await page.evaluate(async (url) => {
        const loader = await import('./pdf-loader.js');
        const ctxMod = await import('../lib/pdf-context.js');
        const ctx = await loader.loadPdfContext(url, { maxChars: 24000 });
        const specific = ctxMod.buildPdfContext({
          fullText: ctx.fullText,
          question: '帮我翻译第 12 页',
          budgetTokens: 3000
        });
        const global = ctxMod.buildPdfContext({
          fullText: ctx.fullText,
          question: '总结这份文档的主要内容',
          budgetTokens: 3000
        });
        return {
          totalChars: ctx.fullText.length,
          mode: specific.mode,
          pagesIncluded: specific.pagesIncluded,
          hasPage12: specific.mainText.includes('[第 12 页]'),
          hasDirectory: specific.mainText.includes('[文档目录'),
          injectedLength: specific.mainText.length,
          globalMode: global.mode,
          globalNeedsFullRead: global.needsFullRead
        };
      }, pdfUrl);

      check(pageSelect.mode === 'selected', '预算不足时进入选页模式（实际 ' + pageSelect.mode + '）');
      check(pageSelect.pagesIncluded.includes(12),
        '第 12 页被强制选中，实际: ' + JSON.stringify(pageSelect.pagesIncluded));
      check(pageSelect.hasPage12 === true, '「翻译第 12 页」的上下文确实包含第 12 页原文');
      check(pageSelect.hasDirectory === true, '同时附带了全文档目录');
      check(pageSelect.injectedLength < pageSelect.totalChars,
        '注入量小于全文（' + pageSelect.injectedLength + ' < ' + pageSelect.totalChars + '）');
      check(pageSelect.globalMode === 'needs-full-read' && pageSelect.globalNeedsFullRead === true,
        '「总结全文」正确触发分段通读');
    } finally {
      await fixture.close();
    }

    // ---- 9. 本地 file:// PDF（用户实际踩到的场景：本地文件在浏览器里看）----
    const localPdfPath = path.join(ROOT, 'tests', 'fixtures', 'test.pdf');
    const localUrl = 'file:///' + localPdfPath.split(path.sep).join('/');

    const localTab = await context.newPage();
    await localTab.goto(localUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await localTab.bringToFront();
    await localTab.waitForTimeout(1000);
    console.log('\n[本地PDF] 已打开 ' + localUrl + '（tab url = ' + localTab.url() + '）');

    const localInfo = await page.evaluate(() => new Promise((resolve) => {
      const port = chrome.runtime.connect({ name: 'page-copilot' });
      const timer = setTimeout(() => {
        try { port.disconnect(); } catch (e) { /* ignore */ }
        resolve({ error: '15s 超时' });
      }, 15000);
      port.onMessage.addListener((msg) => {
        if (msg && msg.type === 'page:info') {
          clearTimeout(timer);
          try { port.disconnect(); } catch (e) { /* ignore */ }
          resolve(msg.info);
        }
      });
      port.postMessage({ type: 'page:get' });
    }));

    check(localInfo.reason === 'PDF_DOCUMENT', 'file:// 本地 PDF 被判为 PDF_DOCUMENT（reason=' + localInfo.reason + '）');
    check(/^file:/i.test(localInfo.url || ''), '后台看到的是 file:// 地址: ' + localInfo.url);

    const fileAccess = await page.evaluate(async () => {
      if (!chrome.extension || !chrome.extension.isAllowedFileSchemeAccess) return 'no-api';
      try {
        return await chrome.extension.isAllowedFileSchemeAccess();
      } catch (e) {
        return 'err';
      }
    });
    console.log('  [INFO] isAllowedFileSchemeAccess = ' + fileAccess);

    const localCtx = await page.evaluate(async (url) => {
      const mod = await import('./pdf-loader.js');
      try {
        const ctx = await mod.loadPdfContext(url, { maxChars: 24000 });
        return {
          ok: ctx.ok,
          pageCount: ctx.pageCount,
          charCount: ctx.charCount,
          title: ctx.title,
          sample: String(ctx.mainText || '').slice(0, 120)
        };
      } catch (e) {
        return { error: (e.name || 'Error') + ': ' + (e.message || String(e)), code: e.code, action: e.action };
      }
    }, localUrl);

    if (fileAccess === true) {
      check(!localCtx.error, 'file:// 本地 PDF 自动读取成功', localCtx.error || '');
      if (!localCtx.error) {
        check(localCtx.pageCount === 14, '页数 14，实际 ' + localCtx.pageCount);
        check(localCtx.charCount > 1000, '提取 ' + localCtx.charCount + ' 字符');
        console.log('  [INFO] 本地 PDF 标题: ' + localCtx.title);
      }
    } else {
      // 权限没开时必须给出准确引导，而不是甩一句"blob 拿不到"
      check(!!localCtx.error, '无文件权限时如实报错（不假装成功）');
      check(localCtx.code === 'FILE_ACCESS_DENIED' || localCtx.code === 'FILE_FETCH_FAILED',
        '错误码指向文件权限而不是 blob（实际 ' + localCtx.code + '）');
      check(/允许访问文件/.test(localCtx.error || ''), '提示里包含开启权限的明确指引');
    }

    // ---- 10. 文件选择器（不依赖任何权限，本地 PDF 的兜底方案）----
    await page.bringToFront();
    let pickedOk = false;
    try {
      await page.setInputFiles('#file-input', localPdfPath);
      // 注意不能只等 "14 页"：解析中的进度文案是 "1/14 页"，会被误匹配。
      // 完成态才会同时出现「页」和「字」。
      await page.waitForFunction(
        () => {
          const meta = (document.getElementById('page-meta') || {}).textContent || '';
          return /页/.test(meta) && /字/.test(meta);
        },
        { timeout: 30000 }
      );
      pickedOk = true;
    } catch (e) {
      pickedOk = false;
    }
    check(pickedOk, '通过文件选择器解析出 14 页（不依赖文件访问权限）');

    if (pickedOk) {
      const pickedUi = await page.evaluate(() => {
        const bar = document.getElementById('notice-bar') || {};
        return {
          title: (document.getElementById('page-title') || {}).textContent || '',
          meta: (document.getElementById('page-meta') || {}).textContent || '',
          noticeHidden: !!bar.hidden,
          noticeDanger: !!(bar.classList && bar.classList.contains('danger')),
          noticeText: (document.getElementById('notice-text') || {}).textContent || ''
        };
      });
      console.log('  [INFO] 文件模式页面条: ' + pickedUi.title + ' | ' + pickedUi.meta);
      // 标题优先取正文首行（比文件名有用），取不到才回退文件名
      check(pickedUi.title.length > 5 && pickedUi.title !== 'PDF 文档',
        '页面条显示出可读标题: ' + pickedUi.title);
      check(/14\s*页/.test(pickedUi.meta), '最终显示解析完成态（非进度文案）: ' + pickedUi.meta);
      check(!pickedUi.noticeDanger, '成功时不显示错误提示（只给用法引导）');
    }

    // ---- 11. blob: 场景必须给准确文案（不能糊弄成"请下载到本地"）----
    const blobErr = await page.evaluate(async () => {
      const mod = await import('./pdf-loader.js');
      try {
        await mod.loadPdfContext('blob:https://example.com/not-a-real-blob', { maxChars: 5000 });
        return { ok: true };
      } catch (e) {
        return { code: e.code, action: e.action, message: e.message };
      }
    });
    check(blobErr.code === 'BLOB_URL', 'blob: 被识别为 BLOB_URL（实际 ' + blobErr.code + '）');
    check(blobErr.action === 'pick-file', 'blob: 场景引导用户改用文件选择');
    check(/文件夹按钮|选择/.test(blobErr.message || ''), 'blob: 文案指向可操作的办法');
  } finally {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  console.log('\n' + (failures === 0 ? '冒烟测试全部通过' : failures + ' 项失败'));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('冒烟测试异常:', err);
  process.exit(1);
});
