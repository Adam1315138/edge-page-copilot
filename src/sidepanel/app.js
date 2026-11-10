/**
 * Page Copilot · 侧边栏逻辑
 *
 * 设计要点：
 * - 对话历史由本页持有，每次请求整体传给后台（后台无状态，SW 回收也不丢）
 * - 流式增量只更新当前这一条 assistant 消息的 DOM，避免整列表重渲染
 * - 渲染 Markdown 有节流，流式结束再补一次完整渲染
 */

import { renderMarkdown, escapeHtml } from '../lib/markdown.js';
import { stripDsml } from '../lib/dsml.js';
import { DEFAULT_SETTINGS, mergeSettings, MODEL_PRESETS, modelSupportsTools } from '../lib/util.js';
import { buildPdfContext } from '../lib/pdf-context.js';
import { loadPdfContext, loadPdfFromFile } from './pdf-loader.js';

const $ = (id) => document.getElementById(id);

const el = {
  statusDot: $('status-dot'),
  pageBar: $('pagebar'),
  pageTitle: $('page-title'),
  pageMeta: $('page-meta'),
  noticeBar: $('notice-bar'),
  noticeText: $('notice-text'),
  noticeAction: $('notice-action'),
  btnOpenFile: $('btn-open-file'),
  fileInput: $('file-input'),
  messages: $('messages'),
  emptyState: $('empty-state'),
  quickActions: $('quick-actions'),
  input: $('input'),
  sendBtn: $('btn-send'),
  btnRefresh: $('btn-refresh'),
  btnNew: $('btn-new'),
  btnSettings: $('btn-settings'),
  togglePage: $('toggle-page'),
  toggleSearch: $('toggle-search'),
  togglePageLabel: $('toggle-page-label'),
  toggleSearchLabel: $('toggle-search-label'),
  hint: $('composer-hint'),
  drawer: $('drawer'),
  drawerMask: $('drawer-mask'),
  btnCloseDrawer: $('btn-close-drawer'),
  btnSave: $('btn-save'),
  btnReset: $('btn-reset'),
  btnToggleKey: $('btn-toggle-key'),
  presetSelect: $('preset-select'),
  modelList: $('model-list')
};

const state = {
  settings: mergeSettings(null),
  messages: [],
  pageInfo: null,
  busy: false,
  includePage: true,
  searchMode: 'auto',
  port: null,
  streaming: null,
  lastRender: 0,
  pdfCache: null,   // { url, ctx } —— PDF 解析结果按 URL 缓存，避免每次提问重解析
  pdfBusy: false,
  pdfError: ''
};

const SEARCH_LABELS = {
  auto: '自动联网',
  always: '强制联网',
  off: '不联网'
};

/* ------------------------------------------------------------------ */
/* 端口                                                                */
/* ------------------------------------------------------------------ */

function connectPort() {
  const port = chrome.runtime.connect({ name: 'page-copilot' });
  state.port = port;
  port.onMessage.addListener(handleBackgroundMessage);
  port.onDisconnect.addListener(() => {
    state.port = null;
    if (state.busy) {
      finishStreaming({ error: '与后台的连接断开了（浏览器回收了后台进程），请重试一次。' });
    }
    setTimeout(() => {
      if (!state.port) connectPort();
    }, 400);
  });
  return port;
}

function postToBackground(msg) {
  if (!state.port) connectPort();
  try {
    state.port.postMessage(msg);
  } catch (e) {
    connectPort();
    try { state.port.postMessage(msg); } catch (e2) { /* 放弃 */ }
  }
}

function handleBackgroundMessage(msg) {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case 'page:info':
      applyPageInfo(msg.info);
      break;

    case 'chat:page':
      applyPageInfo(msg.info);
      break;

    case 'chat:reasoning': {
      if (!state.streaming) break;
      state.streaming.reasoning = (state.streaming.reasoning || '') + msg.text;
      scheduleRender();
      break;
    }

    case 'chat:delta': {
      if (!state.streaming) break;
      state.streaming.content += msg.text;
      scheduleRender();
      break;
    }

    case 'chat:tool': {
      if (!state.streaming) break;
      state.streaming.tools.push({
        name: msg.name,
        status: msg.status,
        detail: msg.detail || '',
        provider: msg.provider || '',
        count: msg.count || 0,
        errors: msg.errors || []
      });
      renderStreamingNow();
      break;
    }

    case 'chat:notice': {
      if (!state.streaming) break;
      state.streaming.notices.push(msg.text);
      renderStreamingNow();
      break;
    }

    case 'chat:sources': {
      if (!state.streaming) break;
      const seen = new Set(state.streaming.sources.map((s) => s.url));
      for (const it of (msg.items || [])) {
        if (it && it.url && !seen.has(it.url)) {
          state.streaming.sources.push(it);
          seen.add(it.url);
        }
      }
      break;
    }

    case 'chat:done':
      finishStreaming({ usage: msg.usage, elapsedMs: msg.elapsedMs });
      break;

    case 'chat:aborted':
      finishStreaming({ stopped: true });
      break;

    case 'chat:error':
      finishStreaming({ error: msg.message, code: msg.code });
      break;

    default:
      break;
  }
}

/* ------------------------------------------------------------------ */
/* 页面信息                                                            */
/* ------------------------------------------------------------------ */

let refreshTimer = null;

function refreshPageInfo() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (!state.port) connectPort();
    postToBackground({ type: 'page:get' });
  }, 120);
}

function formatNumber(n) {
  return Number(n || 0).toLocaleString('zh-CN');
}

function applyPageInfo(info) {
  state.pageInfo = info || null;

  // 用户手动选了本地文件时，页面条保持显示该文件；
  // 想回到当前网页，点刷新按钮即可（会清掉文件缓存）。
  if (state.pdfCache && state.pdfCache.source === 'file' && state.pdfCache.ctx) {
    renderPdfInfo(state.pdfCache.ctx);
    return;
  }

  el.pageBar.classList.remove('error');

  if (!info) {
    el.pageTitle.textContent = '当前页面不可用';
    el.pageMeta.textContent = '';
    el.statusDot.className = 'brand-dot warn';
    return;
  }

  // PDF：注入脚本进不去 Edge 的 PDF 阅读器，改由本地 pdf.js 解析本体
  if (info.reason === 'PDF_DOCUMENT') {
    maybeLoadPdf(info);
    return;
  }

  // 已经不在 PDF 上了，清掉自动解析的缓存；用户手动选的文件保留
  if (state.pdfCache && state.pdfCache.source !== 'file') {
    state.pdfCache = null;
    state.pdfError = '';
  }

  if (!info.ok) {
    el.pageBar.classList.add('error');
    el.pageTitle.textContent = info.message || '读不到这个页面的正文';
    el.pageTitle.title = info.url || '';
    el.pageMeta.textContent = '';
    el.statusDot.className = 'brand-dot warn';
    return;
  }

  const bits = [];
  if (info.charCount) bits.push(formatNumber(info.charCount) + ' 字');
  if (info.hasSelection) bits.push('已选 ' + formatNumber(info.selectionLength) + ' 字');
  if (info.truncated) bits.push('已截断');

  el.pageTitle.textContent = info.title || info.url || '未命名页面';
  el.pageTitle.title = (info.title ? info.title + '\n' : '') + (info.url || '');
  el.pageMeta.textContent = bits.join(' · ');
  el.statusDot.className = 'brand-dot ok';
}

/* ---------------- PDF ---------------- */

/** PDF 用比网页更大的正文上限：一页动辄上千字，按网页的 24000 会截掉大半 */
function pdfMaxChars() {
  return Math.min(60000, Math.max(24000, state.settings.maxPageChars * 2));
}

function showNotice(text, opts = {}) {
  if (!el.noticeBar) return;
  el.noticeText.textContent = text;
  el.noticeBar.hidden = false;
  el.noticeBar.classList.toggle('danger', !!opts.danger);
  if (opts.actionLabel) {
    el.noticeAction.hidden = false;
    el.noticeAction.textContent = opts.actionLabel;
  } else {
    el.noticeAction.hidden = true;
  }
}

function hideNotice() {
  if (el.noticeBar) el.noticeBar.hidden = true;
}

function renderPdfInfo(ctx) {
  hideNotice();
  el.pageBar.classList.remove('error');
  const bits = [];
  if (ctx.pageCount) bits.push(ctx.pageCount + ' 页');
  if (ctx.charCount) bits.push(formatNumber(ctx.charCount) + ' 字');

  el.pageTitle.textContent = ctx.title || 'PDF 文档';
  el.pageTitle.title = (ctx.title || '') + '\n' + (ctx.url || '');
  el.pageMeta.textContent = bits.join(' · ');
  el.statusDot.className = 'brand-dot ok';

  // 浏览器不暴露 PDF 滚动位置，只能在读完时提示用户怎么问才准
  if (ctx.kind === 'pdf' && (ctx.pageCount || 0) > 2) {
    showNotice('全文已读完（' + ctx.pageCount + ' 页）。问「第 N 页讲了什么」或「翻译第 N 页」可以直接定位；'
      + '浏览器不告诉扩展你滚到哪了，所以用「这页」时请顺带说个页码。');
    setTimeout(() => {
      if (!state.pdfError) hideNotice();
    }, 8000);
  }
}

function renderPdfProgress(text) {
  el.pageBar.classList.remove('error');
  el.pageMeta.textContent = text;
  el.statusDot.className = 'brand-dot busy';
}

function renderPdfError(err, url) {
  const message = err && err.message ? err.message : String(err);
  const needsFile = err && (err.action === 'pick-file' || err.action === 'enable-file-access');

  el.pageBar.classList.add('error');
  el.pageTitle.textContent = 'PDF 读取失败';
  el.pageTitle.title = url || '';
  el.pageMeta.textContent = '';
  el.statusDot.className = 'brand-dot warn';

  // 完整原因放在提示条里（pagebar 太窄，长文案会被省略号吃掉）
  showNotice(message, { danger: true, actionLabel: needsFile ? '选择文件' : '' });
}

/**
 * 用户手动选择/拖入的本地 PDF。
 * 这条路不依赖「允许访问文件 URL」权限，永远可用。
 */
async function parseLocalFile(file) {
  if (!file) return;
  if (state.pdfBusy) {
    setHint('正在解析上一个文件');
    return;
  }

  state.pdfBusy = true;
  state.pdfError = '';
  hideNotice();
  el.pageTitle.textContent = file.name || '本地 PDF';
  el.pageTitle.title = file.name || '';
  renderPdfProgress('读取文件…');

  try {
    const ctx = await loadPdfFromFile(file, {
      maxChars: pdfMaxChars(),
      onProgress: (p) => {
        if (p.stage === 'download') renderPdfProgress('读取文件…');
        else if (p.stage === 'open') renderPdfProgress('解析文档…');
        else if (p.stage === 'parse') renderPdfProgress(p.page + '/' + p.total + ' 页');
      }
    });
    state.pdfCache = { url: ctx.url, ctx, source: 'file' };
    renderPdfInfo(ctx);
    setHint('');
  } catch (err) {
    state.pdfError = err && err.message ? err.message : String(err);
    state.pdfCache = { url: 'local-file:' + (file.name || ''), ctx: null, source: 'file' };
    renderPdfError(err, file.name);
  } finally {
    state.pdfBusy = false;
  }
}

function handlePickedFiles(files) {
  const list = Array.from(files || []);
  const file = list.find((f) => /\.pdf$/i.test(f.name || '') || f.type === 'application/pdf');
  if (!file) {
    if (list.length) showNotice('选中的文件不是 PDF', { danger: true });
    return;
  }
  parseLocalFile(file);
}

function openFilePicker() {
  if (el.fileInput) {
    el.fileInput.value = '';
    el.fileInput.click();
  }
}

async function maybeLoadPdf(info, force) {
  const url = info.url || '';
  if (!url) {
    renderPdfError({ message: '拿不到 PDF 地址' }, '');
    return;
  }

  if (!force && state.pdfCache && state.pdfCache.url === url && state.pdfCache.ctx) {
    renderPdfInfo(state.pdfCache.ctx);
    return;
  }
  if (state.pdfBusy) return;
  if (!force && state.pdfCache && state.pdfCache.url === url && state.pdfError) {
    renderPdfError({ message: state.pdfError }, url);
    return;
  }

  state.pdfBusy = true;
  state.pdfError = '';
  hideNotice();
  el.pageTitle.textContent = info.title || 'PDF 文档';
  el.pageTitle.title = url;
  renderPdfProgress('下载中…');

  try {
    const ctx = await loadPdfContext(url, {
      maxChars: pdfMaxChars(),
      onProgress: (p) => {
        if (p.stage === 'download') renderPdfProgress('下载中…');
        else if (p.stage === 'open') renderPdfProgress('解析文档…');
        else if (p.stage === 'parse') renderPdfProgress(p.page + '/' + p.total + ' 页');
      }
    });
    state.pdfCache = { url, ctx, source: 'tab' };
    renderPdfInfo(ctx);
  } catch (err) {
    state.pdfError = err && err.message ? err.message : String(err);
    state.pdfCache = { url, ctx: null, source: 'tab' };
    renderPdfError(err, url);
  } finally {
    state.pdfBusy = false;
  }
}

/** 当前可用的 PDF 上下文 */
function activePdfContext() {
  if (!state.pdfCache || !state.pdfCache.ctx || !state.pdfCache.ctx.ok) return null;
  // 用户手动选的本地文件与当前标签页无关，始终可用
  if (state.pdfCache.source === 'file') return state.pdfCache.ctx;
  const currentUrl = state.pageInfo && state.pageInfo.url;
  if (currentUrl && state.pdfCache.url !== currentUrl) return null;
  return state.pdfCache.ctx;
}

/**
 * 构造本次请求要带的 PDF 上下文。
 *
 * 旧实现有两个致命问题（用户报的「问第 52 页答不出来」就是它）：
 *   1. 只在「已截断」时才按页补充，而全文改成不截断之后这个分支永远不走；
 *   2. 补充方式是往残本后面追加，主上下文仍然缺后半本。
 *
 * 现在统一交给 lib/pdf-context.js：按 token 预算决定整本塞还是挑页，
 * 问题里明确提到的页码会被强制选中（打分 +1000）。
 */
function buildPdfContextForQuestion(question) {
  const base = activePdfContext();
  if (!base) return null;

  const cached = state.pdfCache && state.pdfCache.ctx;
  const fullText = (cached && cached.fullText) || base.mainText || '';

  const result = buildPdfContext({
    fullText,
    question,
    budgetTokens: state.settings.pdfBudgetTokens
  });

  if (!result.mainText) return base;

  return Object.assign({}, base, {
    mainText: result.mainText,
    contextMode: result.mode,
    contextNote: result.note,
    needsFullRead: result.needsFullRead,
    // 只有需要通读全文（分块）时才把全文传过去，正常情况不传
    fullText: result.needsFullRead ? fullText : ''
  });
}

/** 只挑后台需要的字段传过去（fullText 之类的大字段按需传） */
function slimPageContext(ctx) {
  if (!ctx || !ctx.ok) return null;
  return {
    ok: true,
    kind: ctx.kind || 'page',
    title: ctx.title || '',
    url: ctx.url || '',
    pageCount: ctx.pageCount || 0,
    pagesRead: ctx.pagesRead || 0,
    currentPage: ctx.currentPage || 0,
    note: ctx.note || '',
    contextMode: ctx.contextMode || '',
    contextNote: ctx.contextNote || '',
    needsFullRead: !!ctx.needsFullRead,
    mainText: ctx.mainText || '',
    fullText: ctx.fullText || '',
    charCount: ctx.charCount || 0,
    blockCount: ctx.blockCount || 0,
    truncated: !!ctx.truncated
  };
}

/* ------------------------------------------------------------------ */
/* 消息渲染                                                            */
/* ------------------------------------------------------------------ */

function clearEmptyState() {
  if (el.emptyState && el.emptyState.parentNode) {
    el.emptyState.remove();
  }
}

function renderEmptyStateIfNeeded() {
  if (state.messages.length > 0) return;
  if ($('empty-state')) return;
  const div = document.createElement('div');
  div.className = 'empty-state';
  div.id = 'empty-state';
  div.innerHTML = [
    '<div class="empty-logo">◈</div>',
    '<p class="empty-title">问问这个页面</p>',
    '<p class="empty-sub">我会自动读取你当前正在看的网页，需要时再联网查资料。</p>',
    '<div class="quick-actions" id="quick-actions">',
    '<button class="quick" data-action="summarize">总结本页要点</button>',
    '<button class="quick" data-action="explain">解释选中内容</button>',
    '<button class="quick" data-action="detail">展开关键细节</button>',
    '<button class="quick" data-action="translate">翻译成中文</button>',
    '</div>'
  ].join('');
  el.messages.appendChild(div);
  bindQuickActions(div);
}

function scrollToBottom(force) {
  const m = el.messages;
  const distance = m.scrollHeight - m.scrollTop - m.clientHeight;
  if (force || distance < 120) {
    m.scrollTop = m.scrollHeight;
  }
}

function createUserMessage(text) {
  clearEmptyState();
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-user';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  wrap.appendChild(bubble);
  el.messages.appendChild(wrap);
  scrollToBottom(true);
  return wrap;
}

function createAssistantMessage() {
  clearEmptyState();
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-assistant';

  const toolBox = document.createElement('div');
  toolBox.className = 'tool-box';

  const reasoningBox = document.createElement('details');
  reasoningBox.className = 'reasoning';
  reasoningBox.hidden = true;
  reasoningBox.innerHTML = '<summary>思考过程</summary><pre></pre>';

  const body = document.createElement('div');
  body.className = 'body';

  const foot = document.createElement('div');
  foot.className = 'msg-foot';

  wrap.appendChild(toolBox);
  wrap.appendChild(reasoningBox);
  wrap.appendChild(body);
  wrap.appendChild(foot);
  el.messages.appendChild(wrap);

  return { wrap, toolBox, reasoningBox, body, foot };
}

function renderToolLines(container, tools) {
  container.innerHTML = '';
  for (const t of tools) {
    const line = document.createElement('div');
    line.className = 'tool-line';

    let icon = '';
    let label = '';
    if (t.status === 'running') {
      icon = '<span class="spinner"></span>';
      label = (t.name === 'search' ? '正在联网检索「' : '正在读取「') + escapeHtml(t.detail) + '」';
    } else if (t.status === 'done') {
      icon = '<span class="tool-ok">✓</span>';
      if (t.name === 'search') {
        label = '检索「' + escapeHtml(t.detail) + '」· ' + t.count + ' 条结果'
          + (t.provider ? ' · ' + escapeHtml(t.provider) : '');
      } else {
        label = '已读取 ' + escapeHtml(shortUrl(t.detail));
      }
    } else {
      icon = '<span class="tool-fail">✕</span>';
      label = (t.name === 'search' ? '检索失败：' : '读取失败：') + escapeHtml(t.detail || '');
      if (t.errors && t.errors.length) {
        label += '（' + escapeHtml(t.errors.join('；').slice(0, 160)) + '）';
      }
    }
    line.innerHTML = icon + '<span>' + label + '</span>';
    container.appendChild(line);
  }
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname.length > 24 ? u.pathname.slice(0, 24) + '…' : u.pathname);
  } catch (e) {
    return String(url).slice(0, 40);
  }
}

function renderStreamingNow() {
  const s = state.streaming;
  if (!s) return;
  state.lastRender = Date.now();

  renderToolLines(s.dom.toolBox, s.tools);

  if (s.reasoning) {
    s.dom.reasoningBox.hidden = false;
    const pre = s.dom.reasoningBox.querySelector('pre');
    if (pre.textContent !== s.reasoning) pre.textContent = s.reasoning;
  }

  // 流式过程中也要过滤：改后台之前，标记可能已经流进来一小段
  const html = renderMarkdown(stripDsml(s.content || ''));
  const withCursor = html + '<span class="cursor-blink"></span>';
  if (s.dom.body.dataset.html !== withCursor) {
    s.dom.body.innerHTML = withCursor;
    s.dom.body.dataset.html = withCursor;
  }

  scrollToBottom(false);
}

function scheduleRender() {
  const now = Date.now();
  if (now - state.lastRender > 80) {
    renderStreamingNow();
  } else {
    if (state.streaming && !state.streaming.timer) {
      state.streaming.timer = setTimeout(() => {
        state.streaming.timer = null;
        renderStreamingNow();
      }, 90);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 引用角标与来源列表                                                   */
/* ------------------------------------------------------------------ */

/** 在新标签页打开外链。侧边栏是扩展页面，window.open 常被拦，用 chrome.tabs 更可靠 */
function openExternal(url) {
  if (!url) return;
  try {
    if (chrome && chrome.tabs && chrome.tabs.create) {
      chrome.tabs.create({ url });
      return;
    }
  } catch (e) { /* 落到兜底 */ }
  try { window.open(url, '_blank', 'noopener,noreferrer'); } catch (e) { /* ignore */ }
}

/**
 * 把回答里的 [1] [2] 换成可点链接，并在末尾附来源列表。
 * 只动文本节点，跳过代码块和已有链接，避免破坏 Markdown 渲染结果。
 */
function applyCitations(container, sources) {
  if (!container || !sources || sources.length === 0) return;

  const max = sources.length;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = node.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      const tag = p.tagName;
      if (tag === 'CODE' || tag === 'PRE' || tag === 'A') return NodeFilter.FILTER_REJECT;
      return /\[\d{1,2}\]/.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });

  const targets = [];
  let node;
  while ((node = walker.nextNode()) !== null) targets.push(node);

  for (const n of targets) {
    const text = n.nodeValue;
    const frag = document.createDocumentFragment();
    let last = 0;
    const re = /\[(\d{1,2})\]/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const idx = Number(m[1]);
      if (idx < 1 || idx > max) continue;
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const a = document.createElement('a');
      a.className = 'cite';
      a.setAttribute('href', sources[idx - 1].url || '#');
      a.textContent = '[' + idx + ']';
      a.title = sources[idx - 1].title || a.getAttribute('href');
      frag.appendChild(a);
      last = m.index + m[0].length;
    }
    if (last === 0) continue;
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    n.parentNode.replaceChild(frag, n);
  }

  const box = document.createElement('div');
  box.className = 'sources';

  const title = document.createElement('div');
  title.className = 'sources-title';
  title.textContent = '参考来源';
  box.appendChild(title);

  sources.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'source-item';

    const num = document.createElement('span');
    num.className = 'source-num';
    num.textContent = '[' + (i + 1) + ']';
    row.appendChild(num);

    const a = document.createElement('a');
    a.setAttribute('href', s.url || '#');
    a.textContent = s.title || s.url || '(无标题)';
    a.title = s.url || '';
    row.appendChild(a);

    box.appendChild(row);
  });

  container.appendChild(box);
}

function renderMessageFinal(msg, dom) {
  renderToolLines(dom.toolBox, msg.tools || []);

  if (msg.reasoning) {
    dom.reasoningBox.hidden = false;
    dom.reasoningBox.querySelector('pre').textContent = msg.reasoning;
  }

  if (msg.error) {
    dom.body.innerHTML = '';
    const err = document.createElement('div');
    err.className = 'msg-error';
    err.innerHTML = escapeHtml(msg.error);
    if (msg.code === 'NO_KEY') {
      const btn = document.createElement('button');
      btn.className = 'linklike';
      btn.textContent = ' 打开设置';
      btn.addEventListener('click', openDrawer);
      err.appendChild(btn);
    }
    dom.body.appendChild(err);
  } else {
    // 兜底：即使后台没拦住（例如模型把调用写成文本），渲染前也要把 DSML 标记清掉
    const safeContent = stripDsml(msg.content || '');
    const html = renderMarkdown(safeContent);
    dom.body.innerHTML = html || '<p style="color:var(--muted)">（没有返回内容）</p>';
    applyCitations(dom.body, msg.sources);
  }

  // 底部信息：token / 耗时 / 复制
  dom.foot.innerHTML = '';
  const bits = [];
  if (msg.usage && msg.usage.completion_tokens) {
    bits.push('输出 ' + formatNumber(msg.usage.completion_tokens) + ' tokens');
  }
  if (msg.usage && msg.usage.prompt_tokens) {
    bits.push('上下文 ' + formatNumber(msg.usage.prompt_tokens));
  }
  if (msg.elapsedMs) bits.push((msg.elapsedMs / 1000).toFixed(1) + 's');
  if (msg.stopped) bits.push('已停止');

  if (bits.length) {
    const span = document.createElement('span');
    span.textContent = bits.join(' · ');
    dom.foot.appendChild(span);
  }

  if (msg.content) {
    const copyBtn = document.createElement('button');
    copyBtn.textContent = '复制';
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(msg.content);
        copyBtn.textContent = '已复制';
        setTimeout(() => { copyBtn.textContent = '复制'; }, 1200);
      } catch (e) {
        copyBtn.textContent = '复制失败';
      }
    });
    dom.foot.appendChild(copyBtn);
  }
  dom.foot.classList.add('pinned');
}

/* ------------------------------------------------------------------ */
/* 发送与流式结束                                                       */
/* ------------------------------------------------------------------ */

function buildHistoryForRequest() {
  // 排除最后一条 user（本次提问），只带历史轮次
  return state.messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .filter((m) => !m.error)
    .map((m) => ({ role: m.role, content: m.content }));
}

async function sendMessage(rawText) {
  const text = String(rawText || '').trim();
  if (!text || state.busy) return;

  if (!state.settings.apiKey) {
    openDrawer();
    setHint('先填 API Key');
    return;
  }

  if (state.pdfBusy) {
    setHint('PDF 还在解析，稍等一下');
    return;
  }

  const history = buildHistoryForRequest();

  const userMsg = { role: 'user', content: text };
  state.messages.push(userMsg);
  createUserMessage(text);

  const assistantMsg = {
    role: 'assistant',
    content: '',
    reasoning: '',
    tools: [],
    notices: [],
    usage: null
  };
  state.messages.push(assistantMsg);

  const dom = createAssistantMessage();
  state.streaming = {
    content: '',
    reasoning: '',
    tools: [],
    notices: [],
    sources: [],
    dom,
    timer: null
  };

  state.busy = true;
  updateBusyUI();
  el.input.value = '';
  autoResize();
  scrollToBottom(true);

  postToBackground({
    type: 'chat:start',
    payload: {
      text,
      history,
      includePage: state.includePage,
      searchMode: state.searchMode,
      // PDF 只能在扩展页里解析，解析结果随请求一起交给后台
      pageContext: state.includePage ? slimPageContext(buildPdfContextForQuestion(text)) : null
    }
  });

  persistSession();
}

function finishStreaming({ error, code, usage, elapsedMs, stopped } = {}) {
  const s = state.streaming;
  if (!s) return;

  if (s.timer) {
    clearTimeout(s.timer);
    s.timer = null;
  }

  const msg = state.messages[state.messages.length - 1];
  if (msg && msg.role === 'assistant') {
    msg.content = s.content;
    msg.reasoning = s.reasoning;
    msg.tools = s.tools;
    msg.notices = s.notices;
    msg.sources = s.sources || [];
    msg.usage = usage || null;
    msg.elapsedMs = elapsedMs || 0;
    if (error) {
      msg.error = error;
      msg.code = code || '';
    }
    if (stopped) msg.stopped = true;
    renderMessageFinal(msg, s.dom);
  }

  state.streaming = null;
  state.busy = false;
  updateBusyUI();
  scrollToBottom(false);
  persistSession();
}

function updateBusyUI() {
  el.sendBtn.classList.toggle('stop', state.busy);
  el.sendBtn.disabled = state.busy ? false : !el.input.value.trim();
  el.statusDot.className = 'brand-dot ' + (state.busy ? 'busy' : (state.pageInfo && state.pageInfo.ok ? 'ok' : 'warn'));
  el.sendBtn.innerHTML = state.busy
    ? '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>'
    : '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>';
  el.sendBtn.title = state.busy ? '停止生成' : '发送';
}

/* ------------------------------------------------------------------ */
/* 会话持久化（session 级别，关掉浏览器就清空）                          */
/* ------------------------------------------------------------------ */

let persistTimer = null;

function persistSession() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const payload = {
      messages: state.messages.map((m) => ({
        role: m.role,
        content: m.content,
        error: m.error || '',
        usage: m.usage || null
      })),
      includePage: state.includePage,
      searchMode: state.searchMode
    };
    try {
      chrome.storage.session.set({ conversation: payload });
    } catch (e) { /* 老版本浏览器忽略 */ }
  }, 400);
}

async function restoreSession() {
  try {
    const stored = await chrome.storage.session.get('conversation');
    const conv = stored ? stored.conversation : null;
    if (!conv || !Array.isArray(conv.messages) || conv.messages.length === 0) return false;
    state.messages = conv.messages;
    if (typeof conv.includePage === 'boolean') state.includePage = conv.includePage;
    if (conv.searchMode) state.searchMode = conv.searchMode;

    clearEmptyState();
    for (const m of state.messages) {
      if (m.role === 'user') {
        createUserMessage(m.content);
      } else {
        const dom = createAssistantMessage();
        renderMessageFinal(m, dom);
      }
    }
    syncToggles();
    scrollToBottom(true);
    return true;
  } catch (e) {
    return false;
  }
}

function resetConversation() {
  if (state.busy) {
    postToBackground({ type: 'chat:abort' });
  }
  state.messages = [];
  state.streaming = null;
  el.messages.innerHTML = '';
  renderEmptyStateIfNeeded();
  state.busy = false;
  updateBusyUI();
  try { chrome.storage.session.remove('conversation'); } catch (e) { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

async function loadSettings() {
  const stored = await chrome.storage.local.get('settings');
  state.settings = mergeSettings(stored ? stored.settings : null);
  state.searchMode = state.settings.searchMode;
  applySettingsToUI();
  return state.settings;
}

async function saveSettings() {
  const next = mergeSettings({
    apiKey: $('set-apikey').value.trim(),
    baseUrl: $('set-baseurl').value.trim(),
    model: $('set-model').value.trim() || DEFAULT_SETTINGS.model,
    temperature: Number($('set-temperature').value),
    maxPageChars: Number($('set-maxchars').value),
    maxHistoryTurns: Number($('set-history').value),
    searchProvider: $('set-searchprovider').value,
    tavilyKey: $('set-tavilykey').value.trim(),
    allowReadUrl: $('set-readurl').checked,
    showReasoning: $('set-reasoning').checked,
    systemPrompt: $('set-systemprompt').value,
    searchMode: state.searchMode,
    includePageByDefault: state.includePage
  });
  state.settings = next;
  await chrome.storage.local.set({ settings: next });
  applySettingsToUI();
  closeDrawer();
  refreshPageInfo();
  setHint('');
}

function applySettingsToUI() {
  const s = state.settings;
  $('set-baseurl').value = s.baseUrl;
  $('set-model').value = s.model;
  $('set-apikey').value = s.apiKey;
  $('set-temperature').value = s.temperature;
  $('set-maxchars').value = s.maxPageChars;
  $('set-history').value = s.maxHistoryTurns;
  $('set-searchprovider').value = s.searchProvider;
  $('set-tavilykey').value = s.tavilyKey || '';
  $('set-readurl').checked = !!s.allowReadUrl;
  $('set-reasoning').checked = !!s.showReasoning;
  $('set-systemprompt').value = s.systemPrompt || '';
  updateBadges();
  syncToggles();
  el.hint.textContent = s.model || '';
  el.input.placeholder = s.apiKey
    ? '问点什么…（Enter 发送 / Shift+Enter 换行）'
    : '先在设置里填入 API Key…';
}

function updateBadges() {
  $('temp-badge').textContent = Number($('set-temperature').value).toFixed(1);
  $('chars-badge').textContent = formatNumber($('set-maxchars').value);
  $('history-badge').textContent = $('set-history').value;
}

function openDrawer() {
  el.drawer.hidden = false;
  el.drawerMask.hidden = false;
  applySettingsToUI();
}

function closeDrawer() {
  el.drawer.hidden = true;
  el.drawerMask.hidden = true;
}

function setHint(text) {
  el.hint.textContent = text || (state.settings.model || '');
}

/* ------------------------------------------------------------------ */
/* 开关                                                                */
/* ------------------------------------------------------------------ */

function syncToggles() {
  el.togglePage.classList.toggle('on', state.includePage);
  el.togglePageLabel.textContent = state.includePage ? '页面' : '不带页面';
  el.togglePage.title = state.includePage ? '发送时附带当前页面内容（点一下关闭）' : '当前不附带页面内容';

  el.toggleSearch.classList.remove('on', 'forced');
  if (state.searchMode === 'auto') {
    el.toggleSearch.classList.add('on');
  } else if (state.searchMode === 'always') {
    el.toggleSearch.classList.add('forced');
  }
  el.toggleSearchLabel.textContent = SEARCH_LABELS[state.searchMode] || '自动联网';

  const canTools = modelSupportsTools(state.settings.model);
  el.toggleSearch.title = canTools
    ? '点击切换：自动联网 → 强制联网 → 不联网'
    : '当前模型（' + (state.settings.model || '') + '）不支持工具调用，联网走本地预检索';
}

/* ------------------------------------------------------------------ */
/* 输入框                                                              */
/* ------------------------------------------------------------------ */

function autoResize() {
  el.input.style.height = 'auto';
  el.input.style.height = Math.min(168, el.input.scrollHeight) + 'px';
}

function bindQuickActions(root) {
  const actions = {
    summarize: '总结这个页面的核心要点，分条列出，每条一句话。',
    explain: '解释我在页面上选中的这段内容，用通俗的话讲清楚它在说什么、为什么重要。',
    detail: '展开讲讲这个页面里最关键的细节、数据和结论，我需要能直接用的信息。',
    translate: '把这个页面的主要内容翻译成中文，保留原文的结构和层次。'
  };
  root.querySelectorAll('.quick').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.action;
      if (key === 'explain' && state.pageInfo && !state.pageInfo.hasSelection) {
        sendMessage('这个页面主要讲了什么？用通俗的话解释一遍。');
        return;
      }
      sendMessage(actions[key] || actions.summarize);
    });
  });
}

/* ------------------------------------------------------------------ */
/* 事件绑定                                                            */
/* ------------------------------------------------------------------ */

function bindEvents() {
  el.sendBtn.addEventListener('click', () => {
    if (state.busy) {
      postToBackground({ type: 'chat:abort' });
      return;
    }
    sendMessage(el.input.value);
  });

  el.input.addEventListener('input', () => {
    autoResize();
    if (!state.busy) el.sendBtn.disabled = !el.input.value.trim();
  });

  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (state.busy) return;
      sendMessage(el.input.value);
    }
  });

  el.btnRefresh.addEventListener('click', () => {
    // 刷新 = 回到当前标签页：清掉任何 PDF 缓存（含手动选的文件）后重新读取
    if (state.pdfCache) {
      state.pdfCache = null;
      state.pdfError = '';
      hideNotice();
    }
    el.pageTitle.textContent = '正在重新读取…';
    postToBackground({ type: 'page:get' });
  });

  // ---- 本地 PDF：文件按钮 + 拖拽（不依赖文件访问权限）----
  el.btnOpenFile.addEventListener('click', openFilePicker);
  el.noticeAction.addEventListener('click', openFilePicker);
  el.fileInput.addEventListener('change', () => handlePickedFiles(el.fileInput.files));

  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
    dragDepth += 1;
    showNotice('松开鼠标，解析这个 PDF 文件');
  });
  document.addEventListener('dragover', (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  });
  document.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0 && !state.pdfError) hideNotice();
  });
  document.addEventListener('drop', (e) => {
    dragDepth = 0;
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || files.length === 0) return;
    e.preventDefault();
    hideNotice();
    handlePickedFiles(files);
  });

  el.btnNew.addEventListener('click', resetConversation);

  el.btnSettings.addEventListener('click', openDrawer);
  el.btnCloseDrawer.addEventListener('click', closeDrawer);
  el.drawerMask.addEventListener('click', closeDrawer);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.drawer.hidden) closeDrawer();
  });

  el.togglePage.addEventListener('click', () => {
    state.includePage = !state.includePage;
    syncToggles();
    persistSession();
  });

  el.toggleSearch.addEventListener('click', () => {
    const order = ['auto', 'always', 'off'];
    const idx = order.indexOf(state.searchMode);
    state.searchMode = order[(idx + 1) % order.length];
    syncToggles();
    persistSession();
  });

  el.btnSave.addEventListener('click', saveSettings);

  el.btnReset.addEventListener('click', () => {
    state.settings = mergeSettings(null);
    applySettingsToUI();
  });

  el.btnToggleKey.addEventListener('click', () => {
    const input = $('set-apikey');
    const isPassword = input.type === 'password';
    input.type = isPassword ? 'text' : 'password';
    el.btnToggleKey.textContent = isPassword ? '隐藏' : '显示';
  });

  ['set-temperature', 'set-maxchars', 'set-history'].forEach((id) => {
    $(id).addEventListener('input', updateBadges);
  });

  el.presetSelect.addEventListener('change', () => {
    const provider = el.presetSelect.value;
    const preset = MODEL_PRESETS.find((p) => p.provider === provider);
    if (!preset) return;
    $('set-baseurl').value = preset.baseUrl;
    $('set-model').value = preset.models[0];
    el.modelList.innerHTML = preset.models.map((m) => '<option value="' + escapeHtml(m) + '"></option>').join('');
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'tabs:changed') refreshPageInfo();
  });
}

function initPresets() {
  el.presetSelect.innerHTML = '<option value="">手动填写…</option>'
    + MODEL_PRESETS.map((p) => '<option value="' + escapeHtml(p.provider) + '">' + escapeHtml(p.provider) + '</option>').join('');
  el.modelList.innerHTML = MODEL_PRESETS
    .flatMap((p) => p.models)
    .map((m) => '<option value="' + escapeHtml(m) + '"></option>')
    .join('');
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  // 回答里的链接（引用角标、来源列表、正文 URL）一律新标签页打开。
  // 侧边栏里直接点 <a target=_blank> 常常没反应，必须自己接管。
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (!/^https?:\/\//i.test(href)) return;
    e.preventDefault();
    e.stopPropagation();
    openExternal(href);
  }, true);

  initPresets();
  bindEvents();
  bindQuickActions(el.quickActions);

  // 调试钩子：只在 ?debug=1 时暴露，供自动化测试验证引用渲染
  if (String(location.search).indexOf('debug=1') !== -1) {
    window.__pcDebug = { applyCitations, openExternal, stripDsml };
  }
  await loadSettings();
  connectPort();
  refreshPageInfo();

  const hasConversation = await restoreSession();
  if (!hasConversation) renderEmptyStateIfNeeded();

  updateBusyUI();

  if (!state.settings.apiKey) {
    setTimeout(() => openDrawer(), 300);
    setHint('等待配置 API Key');
  }
}

main();
