/**
 * 纯函数工具层：无 DOM / 无 chrome API 依赖，可在 Node 中直接单测。
 */

/* ------------------------------------------------------------------ */
/* 文本工具                                                            */
/* ------------------------------------------------------------------ */

export function decodeEntities(input) {
  if (!input) return '';
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘',
    ldquo: '“', rdquo: '”', middot: '·', copy: '©', reg: '®',
    times: '×', divide: '÷', deg: '°', plusmn: '±', laquo: '«', raquo: '»'
  };
  return String(input).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return m;
      try {
        return String.fromCodePoint(code);
      } catch (e) {
        return m;
      }
    }
    const key = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(named, key) ? named[key] : m;
  });
}

export function collapseWhitespace(str) {
  return String(str || '').replace(/[\s\u00a0]+/g, ' ').trim();
}

export function truncate(str, max) {
  const s = String(str || '');
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

/** 从 HTML 片段中剥离标签，得到干净的纯文本（用于 read_url 工具）。 */
export function htmlToText(html) {
  if (!html) return '';
  let s = String(html);
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|template|svg|head)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<\/(p|div|section|article|li|h[1-6]|tr|blockquote|pre)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/[ \t\u00a0]+/g, ' ');
  s = s.replace(/\n\s*\n\s*\n+/g, '\n\n');
  return s.trim();
}

/* ------------------------------------------------------------------ */
/* 搜索结果解析                                                        */
/* ------------------------------------------------------------------ */

/**
 * DuckDuckGo Lite（https://lite.duckduckgo.com/lite/?q=...）
 * 结构：<a rel="nofollow" href="//duckduckgo.com/l/?uddg=<enc>" class='result-link'>标题</a>
 *       <td class='result-snippet'>摘要</td>
 */
export function parseDuckDuckGoLite(html) {
  const out = [];
  if (!html) return out;
  const linkRe = /<a\b[^>]*class=['"]result-link['"][^>]*>[\s\S]*?<\/a>/gi;
  const links = String(html).match(linkRe) || [];
  for (const block of links) {
    const hrefMatch = block.match(/href=['"]([^'"]+)['"]/i);
    if (!hrefMatch) continue;
    const url = resolveDuckDuckGoUrl(decodeEntities(hrefMatch[1]));
    if (!url) continue;
    const titleMatch = block.match(/>([\s\S]*)<\/a>$/i);
    const title = collapseWhitespace(decodeEntities((titleMatch ? titleMatch[1] : '').replace(/<[^>]+>/g, '')));
    if (!title) continue;
    out.push({ title, url, snippet: '' });
  }
  // 摘要按出现顺序回填
  const snippetRe = /<td\b[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi;
  let m;
  let i = 0;
  while ((m = snippetRe.exec(String(html))) !== null && i < out.length) {
    const text = collapseWhitespace(decodeEntities(m[1].replace(/<[^>]+>/g, ' ')));
    out[i].snippet = text;
    i += 1;
  }
  return out.filter((r) => /^https?:\/\//i.test(r.url));
}

/** DDG 的外链包装：//duckduckgo.com/l/?uddg=<urlencoded>&rut=... */
export function resolveDuckDuckGoUrl(href) {
  const h = String(href || '').trim();
  const m = h.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch (e) {
      return '';
    }
  }
  if (h.startsWith('//')) return 'https:' + h;
  if (/^https?:\/\//i.test(h)) return h;
  return '';
}

/**
 * Bing 网页搜索结果（https://www.bing.com/search?q=...）
 * 结构：<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?...&u=a1<base64url>">标题</a></h2>
 *        <p>摘要</p></li>
 */
export function parseBingResults(html) {
  const out = [];
  if (!html) return out;
  const liRe = /<li\b[^>]*class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = liRe.exec(String(html))) !== null) {
    const block = m[1];
    const aMatch = block.match(/<h2[^>]*>\s*<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!aMatch) continue;
    const url = resolveBingUrl(decodeEntities(aMatch[1]));
    const title = collapseWhitespace(decodeEntities(aMatch[2].replace(/<[^>]+>/g, '')));
    if (!url || !title) continue;
    let snippet = '';
    const pMatch = block.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
    if (pMatch) snippet = collapseWhitespace(decodeEntities(pMatch[1].replace(/<[^>]+>/g, ' ')));
    out.push({ title, url, snippet });
  }
  return out.filter((r) => /^https?:\/\//i.test(r.url));
}

/** Bing 跳转链里的真实地址：u=a1<base64url> */
export function resolveBingUrl(href) {
  const h = String(href || '').trim();
  if (!h) return '';
  if (/^https?:\/\/(?!www\.bing\.com\/ck\/)/i.test(h)) return h;
  const m = h.match(/[?&]u=a1([^&]+)/);
  if (!m) return /^https?:\/\//i.test(h) ? h : '';
  try {
    const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const decoded = typeof atob === 'function'
      ? atob(padded)
      : Buffer.from(padded, 'base64').toString('binary');
    return /^https?:\/\//i.test(decoded) ? decoded : '';
  } catch (e) {
    return '';
  }
}

/** Tavily API 返回 JSON 归一化 */
export function parseTavilyResults(json) {
  const list = (json && Array.isArray(json.results)) ? json.results : [];
  return list
    .filter((r) => r && r.url)
    .map((r) => ({
      title: collapseWhitespace(r.title || r.url),
      url: String(r.url),
      snippet: collapseWhitespace(r.content || r.raw_content || '')
    }));
}

/** 把搜索结果格式化成喂给模型的紧凑文本 */
export function formatSearchResults(results, maxSnippet = 400) {
  if (!Array.isArray(results) || results.length === 0) return '（未检索到结果）';
  return results
    .map((r, i) => {
      const snippet = truncate(collapseWhitespace(r.snippet), maxSnippet);
      return `[${i + 1}] ${r.title}\nURL: ${r.url}${snippet ? '\n摘要: ' + snippet : ''}`;
    })
    .join('\n\n');
}

/* ------------------------------------------------------------------ */
/* SSE 流解析                                                          */
/* ------------------------------------------------------------------ */

/**
 * 增量 SSE 解析器。push() 可接收任意切分的分片，按 SSE 规范以空行分隔事件。
 * onEvent(event: {event, data}) —— data 为多行 data: 的拼接结果。
 */
export function createSSEParser(onEvent) {
  let buffer = '';
  const emit = (rawBlock) => {
    if (!rawBlock) return;
    const lines = rawBlock.split('\n');
    let eventName = 'message';
    const dataLines = [];
    for (const line of lines) {
      if (!line || line.startsWith(':')) continue;
      const idx = line.indexOf(':');
      const field = idx === -1 ? line : line.slice(0, idx);
      let value = idx === -1 ? '' : line.slice(idx + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') eventName = value;
      else if (field === 'data') dataLines.push(value);
    }
    if (dataLines.length === 0) return;
    onEvent({ event: eventName, data: dataLines.join('\n') });
  };

  return {
    push(chunk) {
      buffer += String(chunk).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      let idx = buffer.indexOf('\n\n');
      while (idx !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        emit(block);
        idx = buffer.indexOf('\n\n');
      }
    },
    flush() {
      const rest = buffer.trim();
      buffer = '';
      if (rest) emit(rest);
    }
  };
}

/** 累积流式返回的 tool_calls 分片 */
export function createToolCallAccumulator() {
  const map = new Map();
  return {
    add(deltas) {
      if (!Array.isArray(deltas)) return;
      for (const d of deltas) {
        const index = typeof d.index === 'number' ? d.index : 0;
        let entry = map.get(index);
        if (!entry) {
          entry = { id: '', type: 'function', function: { name: '', arguments: '' } };
          map.set(index, entry);
        }
        if (d.id) entry.id = d.id;
        if (d.type) entry.type = d.type;
        if (d.function) {
          if (d.function.name) entry.function.name += d.function.name;
          if (d.function.arguments) entry.function.arguments += d.function.arguments;
        }
      }
    },
    list() {
      return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    },
    get size() {
      return map.size;
    }
  };
}

/** 安全解析 JSON，失败返回 fallback */
export function safeJsonParse(str, fallback = null) {
  try {
    return JSON.parse(str);
  } catch (e) {
    return fallback;
  }
}

/* ------------------------------------------------------------------ */
/* 配置归一化                                                          */
/* ------------------------------------------------------------------ */

export const DEFAULT_SETTINGS = {
  apiKey: '',
  // 默认按 DeepSeek 预设；换成任何 OpenAI 兼容端点（官方 OpenAI / 硅基流动 / 本地 vLLM）只改这三项
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  temperature: 0.3,
  maxPageChars: 24000,
  maxHistoryTurns: 8,
  // PDF 的上下文预算按 token 算（不是字符数）：英文 82 页也就 3 万多 token，塞得下
  pdfBudgetTokens: 40000,
  systemPrompt: '',
  searchMode: 'auto', // auto: 由模型决定是否检索 | always: 每轮先本地检索 | off: 关闭
  searchProvider: 'bing', // bing | duckduckgo | tavily（DeepSeek 无内置搜索，必须走本地后端）
  tavilyKey: '',
  allowReadUrl: true,
  includePageByDefault: true,
  showReasoning: true,
  streamUsage: true
};

/** 常见预设，UI 下拉用；也允许自由填写 */
export const MODEL_PRESETS = [
  { provider: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { provider: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'] },
  { provider: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', models: ['deepseek-ai/DeepSeek-V3'] },
  { provider: '本地 Ollama', baseUrl: 'http://localhost:11434/v1', models: ['qwen2.5:7b'] }
];

/**
 * DeepSeek 的 reasoner 系列不支持 function calling，这类模型必须走「本地预检索」
 * （先把搜索结果塞进上下文），而不是让模型自己调工具。
 */
export function modelSupportsTools(model) {
  const m = String(model || '').toLowerCase();
  if (!m) return false;
  if (m.includes('reasoner') || m.includes('r1')) return false;
  return true;
}

export function normalizeBaseUrl(input) {
  let url = String(input || '').trim();
  if (!url) url = DEFAULT_SETTINGS.baseUrl;
  url = url.replace(/\s+/g, '');
  url = url.replace(/\/+$/, '');
  url = url.replace(/\/chat\/completions$/i, '');
  return url;
}

export function mergeSettings(stored) {
  const merged = Object.assign({}, DEFAULT_SETTINGS, stored || {});
  merged.baseUrl = normalizeBaseUrl(merged.baseUrl);
  const t = Number(merged.temperature);
  merged.temperature = Number.isFinite(t) ? Math.min(2, Math.max(0, t)) : DEFAULT_SETTINGS.temperature;
  const mpc = Number(merged.maxPageChars);
  merged.maxPageChars = Number.isFinite(mpc) ? Math.min(60000, Math.max(2000, mpc)) : DEFAULT_SETTINGS.maxPageChars;
  const mht = Number(merged.maxHistoryTurns);
  merged.maxHistoryTurns = Number.isFinite(mht) ? Math.min(40, Math.max(1, mht)) : DEFAULT_SETTINGS.maxHistoryTurns;
  const pbt = Number(merged.pdfBudgetTokens);
  merged.pdfBudgetTokens = Number.isFinite(pbt) ? Math.min(120000, Math.max(4000, pbt)) : DEFAULT_SETTINGS.pdfBudgetTokens;
  if (!['duckduckgo', 'bing', 'tavily'].includes(merged.searchProvider)) {
    merged.searchProvider = DEFAULT_SETTINGS.searchProvider;
  }
  if (!['auto', 'always', 'off'].includes(merged.searchMode)) merged.searchMode = DEFAULT_SETTINGS.searchMode;
  return merged;
}

/** 构造发给 /chat/completions 的请求体 */
export function buildChatRequestBody(settings, messages, opts = {}) {
  const body = {
    model: settings.model,
    messages,
    stream: true,
    temperature: settings.temperature
  };
  if (Array.isArray(opts.tools) && opts.tools.length > 0) {
    body.tools = opts.tools;
    body.tool_choice = 'auto';
  }
  return body;
}

/** 把页面 / PDF 上下文拼成注入 user 消息的文本块 */
export function buildPageContextBlock(ctx, opts = {}) {
  if (!ctx || !ctx.ok) return '';
  const includeViewport = opts.includeViewport !== false;
  const lines = [];
  lines.push('<page_context>');

  if (ctx.kind === 'pdf') {
    lines.push('类型: PDF 文档');
    if (ctx.title) lines.push('文件名: ' + ctx.title);
    let pageLine = '页数: ' + (ctx.pageCount || '未知') + ' 页';
    if (ctx.pagesRead && ctx.pageCount && ctx.pagesRead < ctx.pageCount) {
      pageLine += '（本次读取了前 ' + ctx.pagesRead + ' 页）';
    }
    lines.push(pageLine);
    if (ctx.currentPage) lines.push('用户当前浏览到: 第 ' + ctx.currentPage + ' 页');
    if (ctx.contextNote) lines.push('上下文说明: ' + ctx.contextNote);
    if (ctx.contextMode === 'selected') {
      lines.push('注意: 下面是按问题挑选的部分页面 + 全文档目录，不是整本内容。'
        + '如果用户问的页码没在目录之外给出正文，明确说明该页未包含，并提示他可以指定页码重问。');
    } else if (ctx.contextMode === 'needs-full-read') {
      lines.push('注意: 文档很长，正在分段通读全文后汇总。');
    }
    if (ctx.note) lines.push('说明: ' + ctx.note);
  } else {
    if (ctx.title) lines.push('标题: ' + ctx.title);
    if (ctx.siteName) lines.push('站点: ' + ctx.siteName);
  }

  if (ctx.url) lines.push('URL: ' + ctx.url);
  if (ctx.selection) {
    lines.push('');
    lines.push('[用户已选中的文本]');
    lines.push(ctx.selection);
  }
  if (includeViewport && ctx.viewportText) {
    lines.push('');
    lines.push('[用户当前视口内可见的内容]');
    lines.push(ctx.viewportText);
  }
  if (ctx.mainText) {
    lines.push('');
    lines.push('[页面正文]');
    lines.push(ctx.mainText);
  }
  lines.push('</page_context>');
  return lines.join('\n');
}

/** 粗略估算 token（中文按 1.5 字/token，英文按 4 字符/token） */
export function estimateTokens(text) {
  const s = String(text || '');
  let cjk = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code >= 0x2e80 && code <= 0x9fff) cjk += 1;
  }
  const others = s.length - cjk;
  return Math.ceil(cjk / 1.5 + others / 4);
}
