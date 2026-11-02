/**
 * PDF 加载与解析（运行在侧边栏页面，这里有完整 DOM，pdf.js 需要 DOMMatrix 等）。
 *
 * 三条入口：
 *   1. loadPdfContext(url)    —— http(s) / file:// 自动读取当前标签页的 PDF
 *   2. loadPdfFromFile(file)  —— 用户手动选择/拖入的本地文件（不依赖任何权限，永远可用）
 *   3. parsePdfData(...)      —— 上面两者共用的核心解析
 *
 * 关键点：
 * - cmaps 必须带上，否则中文 PDF 会解析成空白/乱码
 * - file:// 需要扩展的「允许访问文件 URL」权限；没开时给准确指引而不是含糊报错
 * - blob: 属于创建它的页面源，扩展拿不到，只能引导用户改用文件选择
 */

import * as pdfjsLib from '../../vendor/pdfjs/pdf.min.mjs';
import { itemsToLines, pagesToText, summarizeText } from '../lib/pdf-text.js';

const MAX_BYTES = 60 * 1024 * 1024; // 60MB，超过就没必要整本塞进上下文了
const MAX_PAGES = 200;
// 极端保护：300 万字符（约 75 万 token）纯属防内存炸，正常文档远远到不了
const HARD_CHAR_LIMIT = 3_000_000;

export class PdfError extends Error {
  constructor(code, message, action) {
    super(message);
    this.name = 'PdfError';
    this.code = code;
    // 给 UI 的后续动作提示：'pick-file' | 'enable-file-access' | ''
    this.action = action || '';
  }
}

let workerConfigured = false;

function vendorBase() {
  return chrome.runtime.getURL('vendor/pdfjs/');
}

function configureWorker() {
  if (workerConfigured) return;
  pdfjsLib.GlobalWorkerOptions.workerSrc = vendorBase() + 'pdf.worker.min.mjs';
  workerConfigured = true;
}

function looksLikePdf(buffer) {
  const head = new Uint8Array(buffer.slice(0, 1024));
  const magic = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
  for (let i = 0; i <= head.length - magic.length; i += 1) {
    let hit = true;
    for (let j = 0; j < magic.length; j += 1) {
      if (head[i + j] !== magic[j]) { hit = false; break; }
    }
    if (hit) return true;
  }
  return false;
}

function parseUrlCurrentPage(url) {
  const m = String(url || '').match(/[#&?]page=(\d+)/i);
  if (!m) return 0;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function guessTitleFromUrl(url) {
  try {
    const u = new URL(url);
    const name = decodeURIComponent(u.pathname.split('/').pop() || '');
    return name.replace(/\.pdf$/i, '') || u.hostname;
  } catch (e) {
    return 'PDF 文档';
  }
}

function titleFromFileName(name) {
  return String(name || '').replace(/\.pdf$/i, '').trim() || '本地 PDF';
}

/** metadata 里的 Title 经常是垃圾（about:blank / Untitled / 空），这些要当没有处理 */
function isJunkTitle(value) {
  const s = String(value || '').trim();
  if (s.length < 3) return true;
  return /^(about:|untitled\b|no\s*title|无标题|未命名|document\s*\d*$|localhost|microsoft word\s*-\s*$)/i.test(s);
}

/**
 * 核心解析：拿到 ArrayBuffer 之后的事情都在这儿。
 */
async function parsePdfData({ data, url, fallbackTitle, maxChars, maxPages, onProgress, currentPage }) {
  configureWorker();

  if (!data || data.byteLength === 0) {
    throw new PdfError('EMPTY', '这个 PDF 是空的（0 字节）');
  }
  if (data.byteLength > MAX_BYTES) {
    throw new PdfError('TOO_LARGE', 'PDF 有 ' + Math.round(data.byteLength / 1024 / 1024) + 'MB，太大了（上限 60MB）');
  }
  if (!looksLikePdf(data)) {
    throw new PdfError('NOT_PDF', '这个文件不是 PDF（文件头里没有 %PDF-）');
  }

  onProgress({ stage: 'open' });
  const base = vendorBase();
  let doc;
  try {
    doc = await pdfjsLib.getDocument({
      data: new Uint8Array(data),
      cMapUrl: base + 'cmaps/',
      cMapPacked: true,
      standardFontDataUrl: base + 'standard_fonts/',
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      verbosity: 0
    }).promise;
  } catch (err) {
    const name = err && err.name ? err.name : '';
    if (name === 'PasswordException') {
      throw new PdfError('PASSWORD', '这个 PDF 有密码保护，读不了正文');
    }
    throw new PdfError('PARSE_FAILED', 'PDF 解析失败：' + (err && err.message ? err.message : String(err)));
  }

  try {
    let title = '';
    try {
      const meta = await doc.getMetadata();
      title = (meta && meta.info && meta.info.Title) || '';
    } catch (e) { /* metadata 缺失不影响 */ }

    const totalPages = doc.numPages;
    const pageLimit = Math.min(totalPages, maxPages);

    const pages = [];
    let charCount = 0;
    let stoppedEarly = false;

    for (let i = 1; i <= pageLimit; i += 1) {
      const page = await doc.getPage(i);
      const textContent = await page.getTextContent();
      const lines = itemsToLines(textContent.items, {});
      pages.push({ pageNumber: i, lines });
      charCount += lines.reduce((s, l) => s + l.text.length, 0);
      onProgress({ stage: 'parse', page: i, total: pageLimit });
      page.cleanup();

      // 只防范极端文件（几百页纯文字会撑爆内存）；正常文档一律读完。
      // 「塞不进上下文」由 lib/pdf-context.js 按 token 预算选页解决，不在这里砍。
      if (charCount > HARD_CHAR_LIMIT) {
        stoppedEarly = i < pageLimit;
        break;
      }
    }

    // metadata 的 Title 常缺失或是垃圾值，退化成正文首行（首页第一行基本就是标题）
    if (isJunkTitle(title)) {
      const firstLines = (pages[0] && pages[0].lines) || [];
      const candidate = firstLines
        .map((l) => String(l.text || '').trim())
        .find((t) => t.length >= 4 && t.length <= 120 && !isJunkTitle(t));
      title = candidate || fallbackTitle || guessTitleFromUrl(url);
    }

    const fullText = pagesToText(pages);
    const stats = summarizeText(fullText);

    if (!fullText.trim()) {
      throw new PdfError(
        'NO_TEXT_LAYER',
        '这个 PDF 没有文本层（多半是扫描件/图片版），读不出文字，需要 OCR 才能处理。'
      );
    }

    // 不再在这里截断：塞不塞得进上下文由 lib/pdf-context.js 按 token 预算决定。
    // 之前在这里砍到 maxChars，是「问第 52 页答不出来」的根源之一。
    const notes = [];
    if (stoppedEarly) notes.push('字符数已达硬上限，提前停止解析');
    if (totalPages > pages.length) {
      notes.push('文档共 ' + totalPages + ' 页，本次读取了前 ' + pages.length + ' 页');
    }

    return {
      ok: true,
      kind: 'pdf',
      url,
      title,
      pageCount: totalPages,
      pagesRead: pages.length,
      currentPage: currentPage || 0,
      mainText: fullText,
      // 完整正文留在侧边栏，按问题挑页时从这里取（不发给后台）
      fullText,
      viewportText: '',
      selection: '',
      charCount: fullText.length,
      rawCharCount: fullText.length,
      blockCount: stats.lines,
      truncated: false,
      notes,
      note: notes.join('；')
    };
  } finally {
    try { await doc.destroy(); } catch (e) { /* ignore */ }
  }
}

/** 检查扩展有没有文件访问权限（API 缺失时按"有"处理，真失败另有报错） */
async function isFileAccessAllowed() {
  try {
    if (chrome.extension && typeof chrome.extension.isAllowedFileSchemeAccess === 'function') {
      return await chrome.extension.isAllowedFileSchemeAccess();
    }
  } catch (e) { /* ignore */ }
  return true;
}

/**
 * 从 URL 加载 PDF（http / https / file://）。
 */
export async function loadPdfContext(url, opts = {}) {
  const maxChars = Math.max(2000, Number(opts.maxChars) || 24000);
  const maxPages = Math.max(1, Math.min(MAX_PAGES, Number(opts.maxPages) || MAX_PAGES));
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const currentPage = Number(opts.currentPage) || parseUrlCurrentPage(url);

  const isHttp = /^https?:/i.test(url);
  const isFile = /^file:/i.test(url);

  if (!isHttp && !isFile) {
    if (/^blob:/i.test(url)) {
      throw new PdfError(
        'BLOB_URL',
        '这个 PDF 是页面用 blob: 临时地址生成的，那个地址属于原页面，扩展拿不到文件本体。请点侧边栏右上角的文件夹按钮，直接选择这个 PDF 文件。',
        'pick-file'
      );
    }
    throw new PdfError(
      'UNSUPPORTED_URL',
      '不支持的地址类型（' + String(url).slice(0, 40) + '）。可以点文件夹按钮直接选择 PDF 文件。',
      'pick-file'
    );
  }

  if (isFile) {
    const allowed = await isFileAccessAllowed();
    if (!allowed) {
      throw new PdfError(
        'FILE_ACCESS_DENIED',
        '扩展还没有「允许访问文件 URL」权限，所以读不到本地 PDF。'
        + '两种办法：① 到 edge://extensions 点本扩展的「详细信息」，打开「允许访问文件 URL」；'
        + '② 直接点上面的文件夹按钮选择这个 PDF。',
        'enable-file-access'
      );
    }
  }

  // ---- 下载 / 读取 ----
  onProgress({ stage: 'download' });
  let res;
  try {
    res = await fetch(url, { credentials: 'include' });
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    if (isFile) {
      throw new PdfError(
        'FILE_FETCH_FAILED',
        '读取本地 PDF 失败（' + message + '）。请确认在 edge://extensions 里已打开本扩展的「允许访问文件 URL」。',
        'enable-file-access'
      );
    }
    throw new PdfError('FETCH_FAILED', '下载 PDF 失败：' + message);
  }

  if (!res.ok) {
    const map = {
      401: '需要登录才能下载这个 PDF（HTTP 401）',
      403: '没有权限下载这个 PDF（HTTP 403）',
      404: 'PDF 文件不存在（HTTP 404）'
    };
    throw new PdfError('HTTP_' + res.status, map[res.status] || ('下载 PDF 失败（HTTP ' + res.status + '）'));
  }

  const contentLength = Number(res.headers.get('content-length') || 0);
  if (contentLength > MAX_BYTES) {
    throw new PdfError('TOO_LARGE', 'PDF 有 ' + Math.round(contentLength / 1024 / 1024) + 'MB，太大了（上限 60MB）');
  }

  const data = await res.arrayBuffer();

  return parsePdfData({
    data,
    url,
    fallbackTitle: guessTitleFromUrl(url),
    maxChars,
    maxPages,
    onProgress,
    currentPage
  });
}

/**
 * 从用户选择的本地文件加载 PDF。
 * 这条路不依赖任何特殊权限，是本地文件最可靠的方式。
 */
export async function loadPdfFromFile(file, opts = {}) {
  const maxChars = Math.max(2000, Number(opts.maxChars) || 24000);
  const maxPages = Math.max(1, Math.min(MAX_PAGES, Number(opts.maxPages) || MAX_PAGES));
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};

  if (!file) throw new PdfError('NO_FILE', '没有选择文件');

  onProgress({ stage: 'download' });
  let data;
  try {
    data = await file.arrayBuffer();
  } catch (err) {
    throw new PdfError('READ_FAILED', '读取文件失败：' + (err && err.message ? err.message : String(err)));
  }

  return parsePdfData({
    data,
    url: 'local-file:' + (file.name || 'file.pdf'),
    fallbackTitle: titleFromFileName(file.name),
    maxChars,
    maxPages,
    onProgress,
    currentPage: 0
  });
}

/** 判断一个标签页 URL 是不是 PDF 场景 */
export function isPdfUrl(url) {
  const u = String(url || '');
  if (/\.pdf(\?|#|$)/i.test(u)) return true;
  if (/^blob:/i.test(u)) return true;
  return false;
}
