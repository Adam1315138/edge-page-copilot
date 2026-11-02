/**
 * 诊断工具：探明 file:// 与 blob: 场景下浏览器/扩展的真实行为。
 *
 *   NODE_PATH=<含 playwright-core 的 node_modules> node tools/diagnose-file-pdf.mjs
 *
 * 打印：标签页 URL 形态、扩展是否有文件访问权限、扩展页能否 fetch 这两种 URL。
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PDF = path.join(ROOT, 'tests', 'fixtures', 'test.pdf');
const FILE_URL = 'file:///' + PDF.split(path.sep).join('/');
const PREFIX = 'chrome-extension://';

async function main() {
  if (!fs.existsSync(EDGE)) {
    console.error('找不到 Edge: ' + EDGE);
    process.exit(2);
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-file-'));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
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
    let workers = ctx.serviceWorkers();
    if (!workers.length) {
      try {
        workers = [await ctx.waitForEvent('serviceworker', { timeout: 15000 })];
      } catch (e) { /* ignore */ }
    }
    let extId = '';
    for (const w of workers) {
      const url = w.url();
      if (url.startsWith(PREFIX)) extId = url.slice(PREFIX.length).split('/')[0];
    }
    console.log('扩展 ID: ' + extId);

    // 1) file:// 打开本地 PDF
    const pdfTab = await ctx.newPage();
    await pdfTab.goto(FILE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
      .catch((e) => console.log('goto 异常: ' + e.message.slice(0, 90)));
    await pdfTab.waitForTimeout(1500);
    console.log('\n[1] file:// 打开后 page.url()  = ' + pdfTab.url());

    // 2) 造一个 blob: PDF（模拟某些下载器/预览器的打开方式）
    const blobTab = await ctx.newPage();
    await blobTab.goto('data:text/html,<html><body>blob</body></html>');
    const b64 = fs.readFileSync(PDF).toString('base64');
    const blobUrl = await blobTab.evaluate((data) => {
      const bin = atob(data);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
      return URL.createObjectURL(new Blob([arr], { type: 'application/pdf' }));
    }, b64);
    console.log('[2] 生成的 blob URL        = ' + blobUrl.slice(0, 64) + '…');

    const side = await ctx.newPage();
    await side.goto('chrome-extension://' + extId + '/src/sidepanel/index.html', { waitUntil: 'domcontentloaded' });

    // 3) 扩展看到的 tab.url
    await pdfTab.bringToFront();
    await pdfTab.waitForTimeout(300);
    const tabInfo = await side.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return tabs[0] ? { url: tabs[0].url, title: tabs[0].title } : null;
    });
    console.log('[3] file:// PDF 的 tab.url  = ' + JSON.stringify(tabInfo));

    // 4) 扩展的文件访问权限
    const allowed = await side.evaluate(async () => {
      if (!chrome.extension || !chrome.extension.isAllowedFileSchemeAccess) return 'API 不可用';
      try {
        return await chrome.extension.isAllowedFileSchemeAccess();
      } catch (e) {
        return 'ERR ' + e.message;
      }
    });
    console.log('[4] isAllowedFileSchemeAccess = ' + allowed);

    // 5) 扩展页 fetch file://
    const fetchFile = await side.evaluate(async (url) => {
      try {
        const r = await fetch(url);
        const buf = await r.arrayBuffer();
        return { ok: r.ok, status: r.status, bytes: buf.byteLength };
      } catch (e) {
        return { error: e.message };
      }
    }, FILE_URL);
    console.log('[5] fetch(file://) = ' + JSON.stringify(fetchFile));

    // 6) 扩展页 fetch blob:
    const fetchBlob = await side.evaluate(async (url) => {
      try {
        const r = await fetch(url);
        const buf = await r.arrayBuffer();
        return { ok: r.ok, status: r.status, bytes: buf.byteLength };
      } catch (e) {
        return { error: e.message };
      }
    }, blobUrl);
    console.log('[6] fetch(blob:)   = ' + JSON.stringify(fetchBlob));

    // 7) 用 <input type=file> 读本地文件（不依赖任何权限）
    const inputResult = await side.evaluate(async () => {
      const input = document.createElement('input');
      input.type = 'file';
      return { created: !!input, hasFiles: 'files' in input };
    });
    console.log('[7] <input type=file> 可用 = ' + JSON.stringify(inputResult));
  } finally {
    await ctx.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    console.log('\n完成');
  }
}

main().catch((err) => {
  console.error('诊断失败:', err);
  process.exit(1);
});
