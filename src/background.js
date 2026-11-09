/**
 * Page Copilot · background service worker
 *
 * 职责：
 *  1. 注入脚本读取当前标签页正文（每次提问前实时抓取）
 *  2. 调用 OpenAI 兼容接口（默认 DeepSeek）流式对话
 *  3. Function Calling 循环：web_search / read_url
 *  4. searchMode=always 或模型不支持 tools 时，走本地预检索
 *
 * 无状态设计：对话历史由侧边栏持有并在每次请求时传入，SW 被回收也不会丢上下文。
 */

import { extractPageContext } from './lib/extract.js';
import { streamChat } from './lib/openai.js';
import { runToolLoop } from './lib/agent.js';
import { searchWeb, readUrl } from './lib/search.js';
import {
  safeJsonParse,
  mergeSettings,
  buildPageContextBlock,
  formatSearchResults,
  modelSupportsTools
} from './lib/util.js';

const MAX_TOOL_ROUNDS = 3;
// 侧边栏传来的 PDF 上下文长度保护（400K 字符 ≈ 20 万 token，纯属防炸内存）
const PDF_CONTEXT_HARD_LIMIT = 400000;

const DEFAULT_SYSTEM_PROMPT = [
  '你是浏览器侧边栏里的网页助手，用户正在阅读某个网页或 PDF，你会在 <page_context> 中拿到该文档的实时内容。',
  '规则：',
  '1. 优先基于 <page_context> 回答。文档里有的信息就按文档说，不要凭训练记忆改写内容。',
  '2. 引用时给出定位（例如「正文第三段」「第 3 页」，PDF 请给页码），不要大段复述原文。',
  '3. 若上下文不足以回答（需要最新消息、文档没写的背景、需要交叉验证），且你有 web_search 工具，就先检索再回答，并用 [1][2] 标注来源。',
  '4. 标记为「视口内」的内容是用户此刻正在看的部分，遇到「这段」「这里」这类指代优先对齐这部分。',
  '5. 不确定就明说，不要编造文档里不存在的细节。',
  '6. 用中文回答，Markdown 格式，长度按问题需要来，不要注水。',
  '7. 如果上下文是 PDF：正文按 [第 N 页] 分页，引用要带页码。PDF 提取的文本常带页眉页脚重复、断行错位、表格被拉平，遇到明显碎片化的内容先按语义重组再回答，必要时说明「原文档此处排版较乱」。',
  '8. 浏览器不会把 PDF 的滚动位置暴露给扩展，所以你无法知道用户「此刻正在看第几页」。用户说「这页」「当前页」「这一页」而上下文里又没有对应内容时，直接请他说明页码（例如「第 52 页」），不要猜、不要含糊其辞。',
  '9. 如果上下文说明里写着「按问题挑选的部分页面」，说明这次只带了部分页 + 目录。用户问的页码若不在其中，明确告诉他这一页这次没带上，请他指定页码重问，不要说「无法获取文本」。'
].join('\n');

/* ------------------------------------------------------------------ */
/* 安装与侧边栏行为                                                     */
/* ------------------------------------------------------------------ */

async function configureSidePanel() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (e) {
    // 旧版本 Edge 不支持该 API 时忽略，action 会走默认行为
  }
}

chrome.runtime.onInstalled.addListener(() => {
  configureSidePanel();
});

configureSidePanel();

/* ------------------------------------------------------------------ */
/* 当前标签页与页面读取                                                 */
/* ------------------------------------------------------------------ */

async function getActiveTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tabs && tabs[0]) return tabs[0];
  } catch (e) { /* ignore */ }
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs && tabs[0]) return tabs[0];
  } catch (e) { /* ignore */ }
  return null;
}

/**
 * 判断一个标签页能不能直接注入脚本。
 * 返回 null 表示可以；否则返回 { code, message }。
 *
 * PDF 单独归类：Edge 的 PDF 阅读器是独立的受保护环境，注入拿不到正文，
 * 但 PDF 本体是可以下载的，所以交给侧边栏用 pdf.js 解析（PDF_DOCUMENT）。
 */
function classifyPage(url) {
  const u = String(url || '');
  if (!u) return { code: 'NO_URL', message: '拿不到当前页面地址' };
  if (/^(chrome|edge|about|devtools|view-source|chrome-extension|extension|moz-extension):/i.test(u)) {
    return { code: 'BLOCKED_PAGE', message: '浏览器内部页面不允许脚本注入，换个普通网页试试' };
  }
  if (/^https:\/\/(chromewebstore\.google\.com|microsoftedge\.microsoft\.com\/addons)/i.test(u)) {
    return { code: 'BLOCKED_PAGE', message: '扩展商店页面受保护，无法读取' };
  }
  if (/\.pdf(\?|#|$)/i.test(u) || /^blob:/i.test(u)) {
    return { code: 'PDF_DOCUMENT', message: 'PDF 文档，交给侧边栏解析' };
  }
  if (/^file:\/\//i.test(u)) {
    return {
      code: 'FILE_URL',
      message: '本地文件需要先在扩展管理页打开「允许访问文件 URL」，否则读不到'
    };
  }
  return null;
}

async function grabPageContext(maxChars) {
  const tab = await getActiveTab();
  if (!tab || tab.id == null) {
    return { ok: false, reason: 'NO_TAB', message: '没有找到活动标签页' };
  }

  const blocked = classifyPage(tab.url);
  if (blocked) {
    return {
      ok: false,
      reason: blocked.code,
      message: blocked.message,
      url: tab.url || '',
      title: tab.title || ''
    };
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractPageContext,
      args: [{ maxChars: maxChars || 24000, viewportMax: 6000 }]
    });
    const ctx = results && results[0] ? results[0].result : null;
    if (!ctx) {
      return { ok: false, reason: 'NO_RESULT', message: '页面没有返回内容', url: tab.url || '', title: tab.title || '' };
    }
    if (!ctx.ok) {
      return {
        ok: false,
        reason: ctx.reason || 'EXTRACT_FAILED',
        message: '这个页面提取不到正文（可能是纯图片、纯脚本渲染或空白页）',
        url: ctx.url || tab.url || '',
        title: ctx.title || tab.title || ''
      };
    }
    return ctx;
  } catch (err) {
    return {
      ok: false,
      reason: 'INJECT_FAILED',
      message: '无法读取该页面：' + (err && err.message ? err.message : String(err)),
      url: tab.url || '',
      title: tab.title || ''
    };
  }
}

/** 只返回给 UI 展示的轻量信息，正文留在 SW 内部不发给界面 */
function toPageInfo(ctx) {
  if (!ctx) {
    return { ok: false, reason: '', message: '', title: '', url: '', kind: 'page' };
  }
  return {
    ok: !!ctx.ok,
    kind: ctx.kind || 'page',
    reason: ctx.reason || '',
    message: ctx.message || '',
    note: ctx.note || '',
    title: ctx.title || '',
    url: ctx.url || '',
    siteName: ctx.siteName || '',
    charCount: ctx.charCount || 0,
    blockCount: ctx.blockCount || 0,
    pageCount: ctx.pageCount || 0,
    pagesRead: ctx.pagesRead || 0,
    currentPage: ctx.currentPage || 0,
    hasSelection: !!ctx.selection,
    selectionLength: ctx.selection ? ctx.selection.length : 0,
    viewportLength: ctx.viewportText ? ctx.viewportText.length : 0,
    truncated: !!ctx.truncated
  };
}

/* ------------------------------------------------------------------ */
/* 联网搜索                                                            */
/* ------------------------------------------------------------------ */

/* 搜索与抓取已迁移到 lib/search.js（searchWeb / readUrl），以便对真实站点独立联调 */

/* ------------------------------------------------------------------ */
/* 工具定义与执行                                                       */
/* ------------------------------------------------------------------ */

function buildTools(settings) {
  const tools = [];
  if (settings.searchMode !== 'off') {
    tools.push({
      type: 'function',
      function: {
        name: 'web_search',
        description: '联网搜索最新的网页资料。当问题需要页面上没有的信息、需要最新消息、或需要核实事实时使用。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词，尽量具体，中文或英文均可' }
          },
          required: ['query']
        }
      }
    });
  }
  if (settings.allowReadUrl && settings.searchMode !== 'off') {
    tools.push({
      type: 'function',
      function: {
        name: 'read_url',
        description: '抓取指定网页的正文内容。用于在搜索之后深入阅读某一条结果的全文。',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: '要读取的完整 http/https 链接' }
          },
          required: ['url']
        }
      }
    });
  }
  return tools;
}

async function runTool(name, args, settings, emit) {
  if (name === 'web_search') {
    const query = String(args && args.query ? args.query : '').trim();
    emit({ type: 'chat:tool', name: 'search', status: 'running', detail: query });
    const { results, provider, errors } = await searchWeb(query, settings);
    emit({
      type: 'chat:tool',
      name: 'search',
      status: results.length ? 'done' : 'error',
      detail: query,
      provider,
      count: results.length,
      errors
    });
    if (results.length === 0) {
      return '搜索失败：' + (errors.join('；') || '未知原因') + '。请直接基于已有信息回答，并告知用户检索未成功。';
    }
    // 把来源发给侧边栏，用于把回答里的 [1][2] 渲染成可点链接
    emit({
      type: 'chat:sources',
      items: results.map((r) => ({ title: r.title || '', url: r.url || '' })).filter((r) => r.url)
    });
    return formatSearchResults(results);
  }

  if (name === 'read_url') {
    const url = String(args && args.url ? args.url : '').trim();
    if (!/^https?:\/\//i.test(url)) return 'URL 不合法，必须以 http:// 或 https:// 开头';
    emit({ type: 'chat:tool', name: 'read', status: 'running', detail: url });
    try {
      const text = await readUrl(url);
      emit({ type: 'chat:tool', name: 'read', status: 'done', detail: url });
      return '页面内容（' + url + '）：\n\n' + text;
    } catch (err) {
      emit({ type: 'chat:tool', name: 'read', status: 'error', detail: url });
      return '读取失败：' + (err && err.message ? err.message : String(err));
    }
  }

  return '未知工具：' + name;
}

/* ------------------------------------------------------------------ */
/* 调用模型                                                            */
/* ------------------------------------------------------------------ */

/**
 * 调用模型：把 openai.js 的增量回调转成端口消息推给侧边栏。
 */
async function callModel({ settings, messages, tools, signal, emit }) {
  return streamChat({
    settings,
    messages,
    tools,
    signal,
    onDelta: (text) => emit({ type: 'chat:delta', text }),
    onReasoning: (text) => {
      if (settings.showReasoning) emit({ type: 'chat:reasoning', text });
    }
  });
}

/* ------------------------------------------------------------------ */
/* 超长 PDF：分段通读 + 汇总（map-reduce）                              */
/* ------------------------------------------------------------------ */

const FULL_READ_CHUNK_CHARS = 24000; // 每块约 6k–8k token，留足输出余量

/**
 * 文档超出单次上下文、且问题需要全局视野时，把全文切块逐段读，
 * 每段只提取「与问题相关的事实」，最后汇总成一份回答。
 */
async function runFullRead({ payload, settings, emit, signal }) {
  const text = String((payload.pageContext && payload.pageContext.fullText) || '');
  const question = String(payload.text || '');
  const title = (payload.pageContext && payload.pageContext.title) || 'PDF 文档';

  const chunks = [];
  for (let i = 0; i < text.length; i += FULL_READ_CHUNK_CHARS) {
    chunks.push(text.slice(i, i + FULL_READ_CHUNK_CHARS));
  }
  const total = chunks.length;

  if (total === 0) {
    return { content: '没有拿到文档正文，无法通读。', usage: null };
  }

  emit({ type: 'chat:notice', text: '《' + title + '》较长，分 ' + total + ' 段通读后汇总' });

  const notes = [];
  for (let i = 0; i < total; i += 1) {
    emit({ type: 'chat:tool', name: 'read', status: 'running', detail: '第 ' + (i + 1) + '/' + total + ' 段' });

    const res = await callModel({
      settings,
      tools: [],
      signal,
      emit: () => {}, // 中间过程不刷屏
      messages: [
        {
          role: 'system',
          content: '你在分段阅读一份很长的文档。只输出这一段里与用户问题相关的事实、数据、结论、页码线索，'
            + '用简短要点列出。不要评论、不要客套、不要下整体结论。若本段完全无关，只回「无相关内容」。'
        },
        {
          role: 'user',
          content: '用户的问题：' + question
            + '\n\n[文档第 ' + (i + 1) + '/' + total + ' 段]\n\n' + chunks[i]
        }
      ]
    });

    notes.push('【第 ' + (i + 1) + '/' + total + ' 段】\n' + (res.content || '（无相关内容）'));
    emit({ type: 'chat:tool', name: 'read', status: 'done', detail: '第 ' + (i + 1) + '/' + total + ' 段' });
  }

  emit({ type: 'chat:notice', text: '已完成 ' + total + ' 段通读，正在汇总' });

  const summaryPrompt = [
    '用户的问题：' + question,
    '',
    '下面是整份文档分 ' + total + ' 段阅读后得到的要点：',
    '',
    notes.join('\n\n'),
    '',
    '请基于以上要点给出完整回答，要求：',
    '1. 覆盖靠后的段落，不要只讲开头几段；',
    '2. 引用时带上页码或段号；',
    '3. 某几段如果确实没有相关内容，直接说明，不要强行填充。'
  ].join('\n');

  const systemPrompt = (settings.systemPrompt && settings.systemPrompt.trim())
    ? settings.systemPrompt.trim()
    : DEFAULT_SYSTEM_PROMPT;

  const final = await callModel({
    settings,
    tools: [],
    signal,
    emit,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: summaryPrompt }
    ]
  });

  return { content: final.content, usage: final.usage };
}

/* ------------------------------------------------------------------ */
/* 一轮完整对话（含工具循环）                                            */
/* ------------------------------------------------------------------ */

async function runTurn({ payload, settings, emit, signal }) {
  const includePage = payload.includePage !== false && settings.includePageByDefault !== false;
  const maxChars = settings.maxPageChars;

  // 1. 上下文：优先用侧边栏已经解析好的（PDF 只能在有 DOM 的页面里解析），否则实时抓当前页
  let ctx = null;
  const provided = payload.pageContext;

  if (provided && provided.ok && provided.mainText) {
    // 侧边栏已经按 token 预算挑好页了，这里只做极端长度保护。
    // 注意：绝不能用网页的 maxPageChars 去砍 —— 那会把 PDF 后半本整段抹掉（v1.1.2 的 bug）。
    const raw = String(provided.mainText);
    ctx = Object.assign({}, provided, {
      mainText: raw.length > PDF_CONTEXT_HARD_LIMIT ? raw.slice(0, PDF_CONTEXT_HARD_LIMIT) : raw
    });
    emit({ type: 'chat:page', info: toPageInfo(ctx) });
  } else if (includePage) {
    ctx = await grabPageContext(maxChars);
    emit({ type: 'chat:page', info: toPageInfo(ctx) });
  }

  const pageBlock = ctx && ctx.ok ? buildPageContextBlock(ctx) : '';

  // 2. 组装消息
  const systemPrompt = (settings.systemPrompt && settings.systemPrompt.trim())
    ? settings.systemPrompt.trim()
    : DEFAULT_SYSTEM_PROMPT;

  const messages = [{ role: 'system', content: systemPrompt }];

  const history = Array.isArray(payload.history) ? payload.history : [];
  const limited = history.slice(-Math.max(1, settings.maxHistoryTurns) * 2);
  for (const m of limited) {
    if (!m || !m.role || m.role === 'system') continue;
    if (m.role === 'assistant' && !m.content) continue;
    messages.push({ role: m.role, content: String(m.content || '') });
  }

  const userText = String(payload.text || '').trim();

  // 2.5 超长 PDF 且问题需要通读全文（总结/概括这类）→ 分段阅读再汇总
  if (ctx && ctx.ok && ctx.kind === 'pdf' && ctx.needsFullRead && ctx.fullText) {
    const fullRead = await runFullRead({ payload: { text: userText, pageContext: ctx }, settings, emit, signal });
    return { content: fullRead.content, usage: fullRead.usage, pageInfo: toPageInfo(ctx) };
  }

  // 3. 搜索策略
  const canUseTools = modelSupportsTools(settings.model);
  const effectiveSearchMode = payload.searchMode || settings.searchMode;
  let preSearchBlock = '';

  // always 模式，或模型不支持 function calling（如 deepseek-reasoner）时，走本地预检索
  if (effectiveSearchMode === 'always' || (effectiveSearchMode === 'auto' && !canUseTools)) {
    if (effectiveSearchMode !== 'off') {
      emit({ type: 'chat:tool', name: 'search', status: 'running', detail: userText.slice(0, 60) });
      const { results, provider, errors } = await searchWeb(userText, settings);
      emit({
        type: 'chat:tool',
        name: 'search',
        status: results.length ? 'done' : 'error',
        detail: userText.slice(0, 60),
        provider,
        count: results.length,
        errors
      });
      if (results.length > 0) {
        emit({
          type: 'chat:sources',
          items: results.map((r) => ({ title: r.title || '', url: r.url || '' })).filter((r) => r.url)
        });
        preSearchBlock = '<search_results>\n以下是针对用户问题的联网检索结果，可作为补充依据，引用时请标注编号：\n\n'
          + formatSearchResults(results)
          + '\n</search_results>';
      }
    }
  }

  const userParts = [];
  if (pageBlock) userParts.push(pageBlock);
  if (preSearchBlock) userParts.push(preSearchBlock);
  userParts.push(userText);
  messages.push({ role: 'user', content: userParts.join('\n\n') });

  // 4. 工具循环
  const tools = (canUseTools && effectiveSearchMode !== 'off') ? buildTools(settings) : [];

  const loopResult = await runToolLoop({
    messages,
    tools,
    maxRounds: MAX_TOOL_ROUNDS,
    callModel: ({ messages: msgs, tools: ts }) => callModel({ settings, messages: msgs, tools: ts, signal, emit }),
    executeTool: async (call) => {
      const fn = call && call.function ? call.function : {};
      const args = safeJsonParse(fn.arguments, {}) || {};
      return runTool(fn.name, args, settings, emit);
    },
    onNotice: (text) => emit({ type: 'chat:notice', text })
  });

  return {
    content: loopResult.content,
    usage: loopResult.usage,
    pageInfo: toPageInfo(ctx)
  };
}

/* ------------------------------------------------------------------ */
/* 端口通信                                                            */
/* ------------------------------------------------------------------ */

async function loadSettings() {
  const stored = await chrome.storage.local.get('settings');
  return mergeSettings(stored ? stored.settings : null);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'page-copilot') return;

  let controller = null;
  let running = false;

  const emit = (msg) => {
    try { port.postMessage(msg); } catch (e) { /* 侧边栏已关闭 */ }
  };

  port.onMessage.addListener(async (msg) => {
    if (!msg || !msg.type) return;

    if (msg.type === 'page:get') {
      const settings = await loadSettings();
      const ctx = await grabPageContext(settings.maxPageChars);
      emit({ type: 'page:info', info: toPageInfo(ctx) });
      return;
    }

    if (msg.type === 'chat:abort') {
      if (controller) controller.abort();
      return;
    }

    if (msg.type === 'chat:start') {
      if (running) {
        emit({ type: 'chat:error', message: '上一个回答还没结束' });
        return;
      }
      const settings = await loadSettings();

      if (!settings.apiKey) {
        emit({ type: 'chat:error', message: '还没有填写 API Key，点右上角齿轮进设置填入 DeepSeek 的 Key。', code: 'NO_KEY' });
        return;
      }

      running = true;
      controller = new AbortController();
      const startedAt = Date.now();

      try {
        const result = await runTurn({
          payload: msg.payload || {},
          settings,
          emit,
          signal: controller.signal
        });
        emit({
          type: 'chat:done',
          usage: result.usage,
          pageInfo: result.pageInfo,
          elapsedMs: Date.now() - startedAt
        });
      } catch (err) {
        const aborted = err && (err.name === 'AbortError' || String(err.message || '').includes('aborted'));
        if (aborted) {
          emit({ type: 'chat:aborted' });
        } else {
          emit({ type: 'chat:error', message: err && err.message ? err.message : String(err) });
        }
      } finally {
        running = false;
        controller = null;
      }
    }
  });

  port.onDisconnect.addListener(() => {
    if (controller) {
      try { controller.abort(); } catch (e) { /* ignore */ }
      controller = null;
    }
  });
});

/* 标签页切换时通知侧边栏刷新页面信息 */
function notifyTabsChanged() {
  chrome.runtime.sendMessage({ type: 'tabs:changed' }).catch(() => {});
}

chrome.tabs.onActivated.addListener(notifyTabsChanged);
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab || !tab.active) return;
  if (changeInfo.status === 'complete' || changeInfo.url) notifyTabsChanged();
});
