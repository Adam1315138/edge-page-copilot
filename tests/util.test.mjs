/**
 * 纯逻辑层单测：文本处理 / SSE 解析 / 搜索结果解析 / 配置归一化
 * 运行：NODE_PATH=<workspace>/node_modules node --test tests/
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  decodeEntities,
  collapseWhitespace,
  htmlToText,
  truncate,
  createSSEParser,
  createToolCallAccumulator,
  parseDuckDuckGoLite,
  parseBingResults,
  resolveDuckDuckGoUrl,
  resolveBingUrl,
  parseTavilyResults,
  formatSearchResults,
  normalizeBaseUrl,
  mergeSettings,
  buildChatRequestBody,
  buildPageContextBlock,
  modelSupportsTools,
  safeJsonParse,
  estimateTokens,
  DEFAULT_SETTINGS
} from '../src/lib/util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

/* ---------------- 文本 ---------------- */

test('decodeEntities 处理命名实体与数字实体', () => {
  assert.equal(decodeEntities('a &amp; b'), 'a & b');
  assert.equal(decodeEntities('&lt;div&gt;'), '<div>');
  assert.equal(decodeEntities('&#39;'), "'");
  assert.equal(decodeEntities('&#x4e2d;'), '中');
  assert.equal(decodeEntities('&nbsp;'), ' ');
  assert.equal(decodeEntities('&unknownEntity;'), '&unknownEntity;');
});

test('collapseWhitespace 压缩空白', () => {
  assert.equal(collapseWhitespace('  a \n\t b\u00a0c  '), 'a b c');
});

test('truncate 不超长且加省略号', () => {
  assert.equal(truncate('abcdef', 3).length, 4);
  assert.ok(truncate('abcdef', 3).endsWith('…'));
  assert.equal(truncate('abc', 3), 'abc');
});

test('htmlToText 剥离脚本样式并保留段落换行', () => {
  const html = `
    <html><head><style>.x{color:red}</style><script>var a=1;</script></head>
    <body>
      <h1>标题</h1>
      <p>第一段&amp;内容</p>
      <p>第二段</p>
      <script>evil()</script>
      <noscript>忽略我</noscript>
    </body></html>`;
  const text = htmlToText(html);
  assert.ok(text.includes('标题'));
  assert.ok(text.includes('第一段&内容'));
  assert.ok(text.includes('第二段'));
  assert.ok(!text.includes('evil'), '脚本内容必须被移除');
  assert.ok(!text.includes('color:red'), '样式必须被移除');
  assert.ok(!text.includes('忽略我'));
  assert.ok(text.includes('\n'), '块级标签应转成换行');
});

/* ---------------- SSE ---------------- */

test('SSE 解析器能在任意字节边界切分下正确还原事件', () => {
  const stream = [
    'data: {"choices":[{"delta":{"content":"你"}}]}',
    '',
    'data: {"choices":[{"delta":{"content":"好"}}]}',
    '',
    'data: [DONE]',
    '',
    ''
  ].join('\n');

  // 逐字符喂入，模拟 TCP 分片最恶劣情况
  const events = [];
  const parser = createSSEParser((e) => events.push(e.data));
  for (const ch of stream) parser.push(ch);
  parser.flush();

  const payloads = events.filter((d) => d !== '[DONE]');
  assert.equal(payloads.length, 2);
  assert.equal(JSON.parse(payloads[0]).choices[0].delta.content, '你');
  assert.equal(JSON.parse(payloads[1]).choices[0].delta.content, '好');
  assert.ok(events.includes('[DONE]'));
});

test('SSE 解析器兼容 CRLF 与多行 data', () => {
  const events = [];
  const parser = createSSEParser((e) => events.push(e));
  parser.push('event: ping\r\ndata: line1\r\ndata: line2\r\n\r\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'ping');
  assert.equal(events[0].data, 'line1\nline2');
});

test('工具调用分片能正确累积', () => {
  const acc = createToolCallAccumulator();
  acc.add([{ index: 0, id: 'call_a', type: 'function', function: { name: 'web_', arguments: '{"que' } }]);
  acc.add([{ index: 0, function: { name: 'search', arguments: 'ry":"abc"}' } }]);
  acc.add([{ index: 1, id: 'call_b', type: 'function', function: { name: 'read_url', arguments: '{"url":"https://x.com"}' } }]);

  const list = acc.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].id, 'call_a');
  assert.equal(list[0].function.name, 'web_search');
  assert.deepEqual(JSON.parse(list[0].function.arguments), { query: 'abc' });
  assert.equal(list[1].function.name, 'read_url');
  assert.equal(acc.size, 2);
});

/* ---------------- 搜索结果解析（真实页面 fixture） ---------------- */

test('DuckDuckGo Lite 真实页面能解析出结果', () => {
  const html = fixture('ddg-lite.html');
  const results = parseDuckDuckGoLite(html);
  assert.ok(results.length >= 5, '应至少解析出 5 条，实际 ' + results.length);
  for (const r of results.slice(0, 3)) {
    assert.match(r.url, /^https?:\/\//, 'URL 必须是绝对地址: ' + r.url);
    assert.ok(r.title.length > 0);
    assert.ok(!r.url.includes('duckduckgo.com/l/'), '必须解开跳转链接');
  }
  assert.ok(results.some((r) => r.snippet.length > 0), '至少要有摘要');
});

test('Bing 真实页面能解析出结果并解开 base64 跳转', () => {
  const html = fixture('bing.html');
  const results = parseBingResults(html);
  assert.ok(results.length >= 5, '应至少解析出 5 条，实际 ' + results.length);
  for (const r of results.slice(0, 5)) {
    assert.match(r.url, /^https?:\/\//, 'URL 必须是绝对地址: ' + r.url);
    assert.ok(!r.url.includes('bing.com/ck/a'), '必须解开 ck/a 跳转');
    assert.ok(r.title.length > 0);
  }
});

test('resolveDuckDuckGoUrl 解开 uddg 参数', () => {
  const href = '//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&rut=abc';
  assert.equal(resolveDuckDuckGoUrl(href), 'https://example.com/a?b=1');
  assert.equal(resolveDuckDuckGoUrl('https://direct.com/x'), 'https://direct.com/x');
  assert.equal(resolveDuckDuckGoUrl('javascript:alert(1)'), '');
});

test('resolveBingUrl 解开 base64url 跳转', () => {
  const target = 'https://example.com/path?a=1';
  const b64 = Buffer.from(target, 'binary').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const href = 'https://www.bing.com/ck/a?!&&p=xyz&u=a1' + b64 + '&ntb=1';
  assert.equal(resolveBingUrl(href), target);
  assert.equal(resolveBingUrl('https://plain.com/x'), 'https://plain.com/x');
});

test('Tavily 结果归一化', () => {
  const json = { results: [{ title: 'A', url: 'https://a.com', content: ' hello  world ' }, { url: 'https://b.com' }, {}] };
  const out = parseTavilyResults(json);
  assert.equal(out.length, 2);
  assert.equal(out[0].snippet, 'hello world');
  assert.equal(out[1].title, 'https://b.com');
});

test('formatSearchResults 输出带编号与 URL', () => {
  const text = formatSearchResults([
    { title: '标题一', url: 'https://a.com', snippet: '摘要一' },
    { title: '标题二', url: 'https://b.com', snippet: '' }
  ]);
  assert.ok(text.includes('[1] 标题一'));
  assert.ok(text.includes('[2] 标题二'));
  assert.ok(text.includes('https://a.com'));
  assert.equal(formatSearchResults([]), '（未检索到结果）');
});

/* ---------------- 配置 ---------------- */

test('normalizeBaseUrl 归一化各种写法', () => {
  assert.equal(normalizeBaseUrl('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1');
  assert.equal(normalizeBaseUrl('https://api.deepseek.com/v1/chat/completions'), 'https://api.deepseek.com/v1');
  assert.equal(normalizeBaseUrl('  https://api.deepseek.com  '), 'https://api.deepseek.com');
  assert.equal(normalizeBaseUrl(''), DEFAULT_SETTINGS.baseUrl);
});

test('mergeSettings 兜底默认值并夹紧数值范围', () => {
  const s = mergeSettings({ temperature: 9, maxPageChars: 1, maxHistoryTurns: 999, searchProvider: 'baidu' });
  assert.equal(s.temperature, 2);
  assert.equal(s.maxPageChars, 2000);
  assert.equal(s.maxHistoryTurns, 40);
  assert.equal(s.searchProvider, DEFAULT_SETTINGS.searchProvider);
  assert.equal(s.baseUrl, DEFAULT_SETTINGS.baseUrl);
  assert.equal(s.model, 'deepseek-chat');
});

test('buildChatRequestBody 在无工具时不下发 tools 字段', () => {
  const settings = mergeSettings(null);
  const withTools = buildChatRequestBody(settings, [], { tools: [{ type: 'function' }] });
  assert.equal(withTools.tools.length, 1);
  assert.equal(withTools.tool_choice, 'auto');
  assert.equal(withTools.stream, true);

  const without = buildChatRequestBody(settings, [], {});
  assert.equal(without.tools, undefined);
});

test('modelSupportsTools 识别 DeepSeek reasoner 不支持工具', () => {
  assert.equal(modelSupportsTools('deepseek-chat'), true);
  assert.equal(modelSupportsTools('deepseek-reasoner'), false);
  assert.equal(modelSupportsTools('deepseek-r1'), false);
  assert.equal(modelSupportsTools('gpt-4o-mini'), true);
  assert.equal(modelSupportsTools(''), false);
});

test('buildPageContextBlock 拼装上下文结构', () => {
  const block = buildPageContextBlock({
    ok: true,
    title: 'T',
    url: 'https://x.com',
    siteName: 'S',
    selection: '选中内容',
    viewportText: '视口内容',
    mainText: '正文内容'
  });
  assert.ok(block.startsWith('<page_context>'));
  assert.ok(block.endsWith('</page_context>'));
  assert.ok(block.includes('选中内容'));
  assert.ok(block.includes('视口内容'));
  assert.ok(block.includes('正文内容'));
  assert.ok(block.includes('URL: https://x.com'));
  assert.equal(buildPageContextBlock(null), '');
  assert.equal(buildPageContextBlock({ ok: false }), '');
});

test('safeJsonParse 与 estimateTokens 基本行为', () => {
  assert.deepEqual(safeJsonParse('{"a":1}'), { a: 1 });
  assert.equal(safeJsonParse('{bad', 'fallback'), 'fallback');
  assert.ok(estimateTokens('hello world') > 0);
  assert.ok(estimateTokens('中文中文') > estimateTokens('ab'));
  assert.equal(estimateTokens(''), 0);
});
