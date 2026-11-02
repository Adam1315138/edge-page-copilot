/**
 * Markdown 渲染测试。重点：模型输出属于不可信内容，任何 HTML/协议注入都必须被挡掉。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, escapeHtml, sanitizeUrl } from '../src/lib/markdown.js';

test('基础块级元素', () => {
  const html = renderMarkdown('# 标题\n\n段落一。\n\n## 二级\n\n- a\n- b\n\n1. x\n2. y');
  assert.ok(html.includes('<h1>标题</h1>'));
  assert.ok(html.includes('<h2>二级</h2>'));
  assert.ok(html.includes('<p>段落一。</p>'));
  assert.ok(html.includes('<ul>'));
  assert.ok(html.includes('<li>a</li>'));
  assert.ok(html.includes('<ol>'));
  assert.ok(html.includes('<li>x</li>'));
});

test('行内样式与链接', () => {
  const html = renderMarkdown('**粗体** 与 *斜体* 与 `code` 与 [链接](https://example.com)');
  assert.ok(html.includes('<strong>粗体</strong>'));
  assert.ok(html.includes('<em>斜体</em>'));
  assert.ok(html.includes('<code>code</code>'));
  assert.ok(html.includes('href="https://example.com"'));
  assert.ok(html.includes('rel="noopener noreferrer"'));
});

test('代码块保留原文并标注语言', () => {
  const html = renderMarkdown('```js\nconst a = 1 < 2;\n```');
  assert.ok(html.includes('<pre><code class="language-js">'));
  assert.ok(html.includes('const a = 1 &lt; 2;'), '代码块内的 < 必须转义');
});

test('表格渲染', () => {
  const html = renderMarkdown('| 名 | 值 |\n|---|---|\n| a | 1 |\n| b | 2 |');
  assert.ok(html.includes('<table>'));
  assert.ok(html.includes('<th>名</th>'));
  assert.ok(html.includes('<td>a</td>'));
  assert.ok(html.includes('<td>2</td>'));
});

test('引用与分隔线', () => {
  const html = renderMarkdown('> 引用内容\n\n---\n');
  assert.ok(html.includes('<blockquote>引用内容</blockquote>'));
  assert.ok(html.includes('<hr>'));
});

test('XSS：script 标签必须被转义', () => {
  const html = renderMarkdown('<script>alert(1)</script>');
  assert.ok(!html.includes('<script>'), '不能输出可执行的 script 标签');
  assert.ok(html.includes('&lt;script&gt;'));
});

test('XSS：img onerror 必须被转义', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)>');
  assert.ok(!html.includes('<img'), '不能输出 img 标签');
  assert.ok(html.includes('&lt;img'));
});

test('XSS：javascript: 协议链接被降级为纯文本', () => {
  const html = renderMarkdown('[点我](javascript:alert(1))');
  assert.ok(!html.toLowerCase().includes('javascript:alert'), '不能生成可点击的 javascript 链接');
  assert.ok(!html.includes('href='), '这种链接不应生成 href');
  assert.ok(html.includes('点我'));
});

test('XSS：data: 协议链接被拒绝', () => {
  const html = renderMarkdown('[x](data:text/html,<script>alert(1)</script>)');
  assert.ok(!html.includes('href="data:'));
});

test('XSS：属性引号注入无法逃逸', () => {
  const html = renderMarkdown('[x](https://a.com/" onmouseover="alert(1))');
  assert.ok(!/onmouseover="alert\(1\)"/.test(html), '不能注入事件属性');
});

test('sanitizeUrl 只放行安全协议', () => {
  assert.equal(sanitizeUrl('https://a.com'), 'https://a.com');
  assert.equal(sanitizeUrl('http://a.com'), 'http://a.com');
  assert.equal(sanitizeUrl('mailto:a@b.com'), 'mailto:a@b.com');
  assert.equal(sanitizeUrl('//a.com'), 'https://a.com');
  assert.equal(sanitizeUrl('javascript:alert(1)'), '');
  assert.equal(sanitizeUrl('data:text/html,x'), '');
  assert.equal(sanitizeUrl(''), '');
});

test('escapeHtml 覆盖五个关键字符', () => {
  assert.equal(escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
});

test('未闭合代码块不会吞掉异常，仍能输出', () => {
  const html = renderMarkdown('```\n未闭合代码');
  assert.ok(html.includes('<pre><code>'));
  assert.ok(html.includes('未闭合代码'));
});

test('空输入返回空串，不抛错', () => {
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown(null), '');
  assert.equal(renderMarkdown(undefined), '');
});

test('裸链接自动变成可点击', () => {
  const html = renderMarkdown('参考 https://example.com/doc 这里');
  assert.ok(html.includes('<a href="https://example.com/doc"'));
});

test('列表与段落紧邻时正确闭合', () => {
  const html = renderMarkdown('- 一\n- 二\n\n结尾段落。');
  assert.ok(/<\/ul>\s*<p>结尾段落。<\/p>/.test(html), '实际输出: ' + html);
});
