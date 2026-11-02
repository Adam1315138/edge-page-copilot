/**
 * 联网检索与网页抓取。
 *
 * 独立成模块的原因：可以在 Node 里对真实站点跑联调，验证解析器不是只对 fixture 有效。
 * 所有函数都支持注入 fetchImpl，方便测试与替换。
 */

import {
  parseDuckDuckGoLite,
  parseBingResults,
  parseTavilyResults,
  htmlToText,
  truncate
} from './util.js';

export const DEFAULT_TIMEOUT_MS = 15000;
export const READ_TIMEOUT_MS = 20000;
export const MAX_RESULTS = 6;

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await doFetch(url, Object.assign({}, options, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

export async function searchDuckDuckGo(query, opts = {}) {
  const url = 'https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(query);
  const res = await fetchWithTimeout(url, {
    method: 'GET',
    headers: Object.assign(
      { Accept: 'text/html,application/xhtml+xml,text/html;q=0.9,*/*;q=0.8' },
      opts.headers || {}
    )
  }, opts.timeoutMs || DEFAULT_TIMEOUT_MS, opts.fetchImpl);

  if (!res.ok) throw new Error('DuckDuckGo 返回 HTTP ' + res.status);
  const html = await res.text();
  const results = parseDuckDuckGoLite(html);
  if (results.length === 0) throw new Error('DuckDuckGo 没有解析到结果（可能触发了风控）');
  return results.slice(0, MAX_RESULTS);
}

export async function searchBing(query, opts = {}) {
  const url = 'https://www.bing.com/search?q=' + encodeURIComponent(query) + '&setlang=zh-CN&form=QBLH';
  const res = await fetchWithTimeout(url, {
    method: 'GET',
    headers: Object.assign(
      { Accept: 'text/html,application/xhtml+xml,text/html;q=0.9,*/*;q=0.8' },
      opts.headers || {}
    )
  }, opts.timeoutMs || DEFAULT_TIMEOUT_MS, opts.fetchImpl);

  if (!res.ok) throw new Error('Bing 返回 HTTP ' + res.status);
  const html = await res.text();
  const results = parseBingResults(html);
  if (results.length === 0) throw new Error('Bing 没有解析到结果');
  return results.slice(0, MAX_RESULTS);
}

export async function searchTavily(query, apiKey, opts = {}) {
  const res = await fetchWithTimeout('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: 'basic',
      max_results: 5,
      include_answer: false
    })
  }, opts.timeoutMs || DEFAULT_TIMEOUT_MS, opts.fetchImpl);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('Tavily 返回 HTTP ' + res.status + ' ' + truncate(text, 160));
  }
  const json = await res.json();
  const results = parseTavilyResults(json);
  if (results.length === 0) throw new Error('Tavily 没有返回结果');
  return results;
}

/**
 * 多后端检索：首选后端失败就自动降级，保证「搜索」这个动作不会整体失败。
 *
 * @returns {Promise<{results: Array, provider: string, errors: string[]}>}
 */
export async function searchWeb(query, settings = {}, opts = {}) {
  const q = String(query || '').trim();
  if (!q) return { results: [], provider: 'none', errors: ['查询为空'] };

  const errors = [];
  const order = [];
  const preferred = settings.searchProvider || 'duckduckgo';
  const hasTavily = !!(settings.tavilyKey && String(settings.tavilyKey).trim());

  if (preferred === 'tavily' && hasTavily) order.push('tavily');
  order.push(preferred === 'bing' ? 'bing' : 'duckduckgo');
  if (preferred !== 'bing') order.push('bing');
  if (preferred !== 'duckduckgo') order.push('duckduckgo');
  if (hasTavily) order.push('tavily');

  const unique = [...new Set(order)];

  for (const provider of unique) {
    try {
      if (provider === 'tavily') {
        if (!hasTavily) {
          errors.push('Tavily：未配置 API Key');
          continue;
        }
        const results = await searchTavily(q, settings.tavilyKey, opts);
        return { results, provider, errors };
      }
      if (provider === 'bing') {
        const results = await searchBing(q, opts);
        return { results, provider, errors };
      }
      const results = await searchDuckDuckGo(q, opts);
      return { results, provider, errors };
    } catch (err) {
      errors.push(provider + '：' + (err && err.message ? err.message : String(err)));
    }
  }

  return { results: [], provider: 'none', errors };
}

export async function readUrl(url, opts = {}) {
  const res = await fetchWithTimeout(url, {
    method: 'GET',
    headers: Object.assign(
      { Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8' },
      opts.headers || {}
    )
  }, opts.timeoutMs || READ_TIMEOUT_MS, opts.fetchImpl);

  if (!res.ok) throw new Error('抓取失败 HTTP ' + res.status);
  const contentType = String(res.headers.get('content-type') || '');

  if (contentType.includes('application/json')) {
    const text = await res.text();
    return truncate(text, 6000);
  }

  const html = await res.text();
  const text = htmlToText(html);
  if (text.length < 80) throw new Error('页面没有可读文本（可能是纯 JS 渲染）');
  return truncate(text, 8000);
}
