/**
 * 真实网络联调：直接请求 DuckDuckGo / Bing，验证解析器在真实站点上也能用。
 * 断网或站点风控时自动 skip，不会误报失败。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { searchWeb, readUrl, searchDuckDuckGo, searchBing } from '../src/lib/search.js';
import { formatSearchResults } from '../src/lib/util.js';

/**
 * 实测结论（tools/diagnose-search.mjs）：伪造浏览器 UA **反而**会让 Bing 判定为爬虫，
 * 返回 challenge 页、b_algo=0；用 Node 默认 UA 才能拿到正常结果（b_algo=10）。
 * 产品跑在真实浏览器里，走的是原生指纹，不受这条影响。
 */
const browserFetch = (url, opts = {}) => fetch(url, opts);

const isNetworkIssue = (err) => {
  const msg = String((err && err.message) || err || '');
  return /ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT|fetch failed|network|aborted|timed?\s*out|socket hang up/i.test(msg);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 真实站点会抖，重试两次再判失败，避免把网络波动当成代码 bug */
async function withRetry(fn, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep(2500);
    }
  }
  throw lastErr;
}

test('searchWeb 真实检索（默认 DuckDuckGo）', { timeout: 40000 }, async (t) => {
  let out;
  try {
    out = await withRetry(() => searchWeb('DeepSeek API 定价', { searchProvider: 'duckduckgo' }, { fetchImpl: browserFetch }));
  } catch (err) {
    if (isNetworkIssue(err)) return t.skip('网络不可用：' + err.message);
    throw err;
  }

  assert.ok(out.results.length >= 3, '真实检索应至少返回 3 条，实际 ' + out.results.length + '，errors=' + out.errors.join('|'));
  assert.ok(['duckduckgo', 'bing'].includes(out.provider), '实际 provider=' + out.provider);

  for (const r of out.results) {
    assert.match(r.url, /^https?:\/\//, 'URL 必须是绝对地址: ' + r.url);
    assert.ok(r.title.length > 0);
    assert.ok(!r.url.includes('duckduckgo.com/l/'), '跳转链接必须解开');
  }

  const text = formatSearchResults(out.results);
  assert.ok(text.includes('[1]'));
  assert.ok(text.length > 100, '格式化后应有实际内容');
});

test('Bing 后端单独可用', { timeout: 40000 }, async (t) => {
  let results;
  try {
    results = await withRetry(() => searchBing('TypeScript 5 release notes', { fetchImpl: browserFetch }));
  } catch (err) {
    if (isNetworkIssue(err)) return t.skip('网络不可用：' + err.message);
    throw err;
  }
  assert.ok(results.length >= 3, 'Bing 应返回至少 3 条，实际 ' + results.length);
  assert.ok(results.every((r) => /^https?:\/\//.test(r.url)));
});

test('DuckDuckGo 后端单独可用', { timeout: 40000 }, async (t) => {
  let results;
  try {
    results = await withRetry(() => searchDuckDuckGo('MDN fetch API', { fetchImpl: browserFetch }));
  } catch (err) {
    if (isNetworkIssue(err)) return t.skip('网络不可用：' + err.message);
    throw err;
  }
  assert.ok(results.length >= 3, 'DDG 应返回至少 3 条，实际 ' + results.length);
});

test('首选后端不可用时自动降级到另一个', { timeout: 60000 }, async (t) => {
  // 故意指向一个必然失败的 Tavily（无 Key），验证降级链
  let out;
  try {
    out = await withRetry(() => searchWeb('JavaScript', { searchProvider: 'tavily', tavilyKey: '' }, { fetchImpl: browserFetch }));
  } catch (err) {
    if (isNetworkIssue(err)) return t.skip('网络不可用：' + err.message);
    throw err;
  }
  assert.ok(out.provider !== 'tavily', '没有 Key 时不该走 Tavily');
  assert.ok(out.results.length >= 3, '降级后应拿到结果');
});

test('readUrl 能抓取真实页面正文', { timeout: 40000 }, async (t) => {
  let text;
  try {
    text = await withRetry(() => readUrl('https://example.com', { fetchImpl: browserFetch }));
  } catch (err) {
    if (isNetworkIssue(err)) return t.skip('网络不可用：' + err.message);
    throw err;
  }
  assert.ok(text.length > 40, '抓到内容太短: ' + text.slice(0, 100));
  assert.ok(/example/i.test(text), '应包含页面正文关键词');
  assert.ok(!text.includes('<html'), '标签必须被剥离');
});

test('未知域名会抛错而不是返回空', { timeout: 30000 }, async (t) => {
  try {
    await readUrl('https://this-domain-definitely-does-not-exist-12345.invalid', { fetchImpl: browserFetch, timeoutMs: 8000 });
    assert.fail('应该抛错');
  } catch (err) {
    if (err.code === 'ERR_ASSERTION') throw err;
    assert.ok(err instanceof Error);
  }
});
