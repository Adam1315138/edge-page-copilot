/**
 * 页面正文提取器测试。
 *
 * 关键点：用 toString() + eval 还原函数再执行，模拟 chrome.scripting.executeScript
 * 的真实注入方式 —— 一旦函数体内引用了模块作用域变量，这个测试就会红。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { extractPageContext } from '../src/lib/extract.js';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');

/** 模拟浏览器注入：把函数源码单独 eval 出来，脱离原本的模块作用域 */
function revive() {
  // eslint-disable-next-line no-eval
  return eval('(' + extractPageContext.toString() + ')');
}

function rect(left, top, width, height) {
  return {
    left, top, width, height,
    right: left + width,
    bottom: top + height,
    x: left, y: top,
    toJSON() { return this; }
  };
}

/**
 * 建立 jsdom 环境并挂到全局（extractPageContext 内部用的是全局 document/window）
 * @param {string} html
 * @param {{layout?: boolean, innerHeight?: number}} opts
 */
function setup(html, opts = {}) {
  const dom = new JSDOM(html, { pretendToBeVisual: true });
  const win = dom.window;

  if (opts.layout) {
    // 有布局模式：body 有尺寸；带 data-invp="1" 的元素落到视口内，其余远在下方
    win.Element.prototype.getBoundingClientRect = function getRect() {
      if (this === win.document.body || this === win.document.documentElement) {
        return rect(0, 0, 1000, 4000);
      }
      if (this.dataset && this.dataset.invp === '1') return rect(0, 120, 1000, 60);
      return rect(0, 5000, 1000, 60);
    };
  }
  if (opts.innerHeight) {
    Object.defineProperty(win, 'innerHeight', { value: opts.innerHeight, configurable: true });
  }

  global.window = win;
  global.document = win.document;
  return { dom, win, cleanup: () => { delete global.window; delete global.document; } };
}

const LONG_PARAGRAPH = '这是一段足够长的正文内容，用来验证提取器能够识别文章主体并且通过噪音过滤器的长度阈值检查，不应该被误判成导航或广告。';

function longArticleHtml({ withNoise = true } = {}) {
  const paragraphs = Array.from({ length: 8 }, (_, i) =>
    `<p ${i === 2 ? 'data-invp="1"' : ''}>第 ${i + 1} 段：${LONG_PARAGRAPH}</p>`
  ).join('\n');
  return `<!DOCTYPE html><html><head><title>深入理解流式渲染</title>
    <meta name="description" content="一篇讲 SSE 的文章">
    <meta property="og:site_name" content="技术博客">
    </head><body>
    ${withNoise ? '<nav class="top-nav"><a href="/">首页</a><a href="/c">分类</a></nav>' : ''}
    <header><h1>深入理解流式渲染</h1></header>
    <article class="post-content">
      <h2>为什么需要流式</h2>
      ${paragraphs}
      <ul><li>要点甲：SSE 基于纯文本协议</li><li>要点乙：需要处理分片边界</li></ul>
      <pre><code>const parser = createSSEParser(cb);</code></pre>
    </article>
    ${withNoise ? '<div class="sidebar"><p>相关推荐阅读</p></div>' : ''}
    ${withNoise ? '<footer><p>版权所有 保留所有权利</p></footer>' : ''}
    <div style="display:none"><p>这段内容被隐藏了不该出现</p></div>
    <script>window.evil = '不该出现的脚本'</script>
    </body></html>`;
}

/* ------------------------------------------------------------------ */

test('函数自包含：能被单独 eval 出来并正常执行（模拟真实注入）', () => {
  const fn = revive();
  assert.equal(typeof fn, 'function');
  assert.notEqual(fn, extractPageContext, 'eval 出来的应该是独立副本');

  const src = extractPageContext.toString();
  assert.ok(!/\bimport\s|\brequire\(/.test(src), '函数体内不得出现 import/require');
  assert.ok(!/U\.\w|util\./.test(src), '函数体内不得引用外部命名空间');

  const env = setup('<html><head><title>T</title></head><body><p>正文内容足够长，可以通过长度检查。</p></body></html>');
  try {
    const result = fn({ maxChars: 5000 });
    assert.equal(result.ok, true);
    assert.ok(result.mainText.includes('正文内容足够长'));
  } finally {
    env.cleanup();
  }
});

test('长文：能选中 article 作为正文根并提取结构化文本', () => {
  const env = setup(longArticleHtml(), { layout: true, innerHeight: 800 });
  try {
    const r = revive()({ maxChars: 24000 });
    assert.equal(r.ok, true);
    assert.equal(r.title, '深入理解流式渲染');
    assert.equal(r.siteName, '技术博客');
    assert.equal(r.description, '一篇讲 SSE 的文章');

    assert.ok(r.mainText.includes('第 1 段'), '应包含正文段落');
    assert.ok(r.mainText.includes('第 8 段'), '长文尾部段落不能丢');
    assert.ok(r.mainText.includes('要点甲'), '列表项应保留');
    assert.ok(r.mainText.includes('createSSEParser'), '代码块内容应保留');
    assert.ok(r.mainText.includes('## 为什么需要流式'), '标题应带层级标记');

    assert.ok(!r.mainText.includes('相关推荐阅读'), '侧边栏噪音必须被过滤');
    assert.ok(!r.mainText.includes('版权所有'), '页脚必须被过滤');
    assert.ok(!r.mainText.includes('这段内容被隐藏了'), 'display:none 的内容必须被过滤');
    assert.ok(!r.mainText.includes('不该出现的脚本'), 'script 内容必须被过滤');
  } finally {
    env.cleanup();
  }
});

test('视口内容被单独标记，且正文与全文一致', () => {
  const env = setup(longArticleHtml(), { layout: true, innerHeight: 800 });
  try {
    const r = revive()({ maxChars: 24000 });
    assert.equal(r.hasLayout, true);
    assert.ok(r.viewportText.includes('第 3 段'), 'data-invp 标记的段落应进入视口文本');
    assert.ok(!r.viewportText.includes('第 1 段'), '视口外段落不应进入视口文本');
    assert.ok(r.viewportText.length < r.mainText.length);
  } finally {
    env.cleanup();
  }
});

test('短页面：退回 body 仍能过滤导航与页脚', () => {
  const html = `<html><head><title>短页</title></head><body>
    <nav><a>导航链接</a></nav>
    <div id="main"><p>正文只有一句话但是有内容。</p></div>
    <footer><p>页脚版权信息</p></footer>
  </body></html>`;
  const env = setup(html);
  try {
    const r = revive()({ maxChars: 5000 });
    assert.equal(r.ok, true);
    assert.ok(r.mainText.includes('正文只有一句话'));
    assert.ok(!r.mainText.includes('页脚版权信息'));
  } finally {
    env.cleanup();
  }
});

test('长文截断：超限时置 truncated 且保留视口片段', () => {
  // 视口元素刻意放在末尾，验证截断后仍会把视口内容补回
  const paragraphs = Array.from({ length: 40 }, (_, i) =>
    `<p ${i === 39 ? 'data-invp="1"' : ''}>第 ${i + 1} 段：${LONG_PARAGRAPH}</p>`
  ).join('');
  const html = `<html><head><title>长文</title></head><body><article>${paragraphs}</article></body></html>`;

  const env = setup(html, { layout: true, innerHeight: 800 });
  try {
    const r = revive()({ maxChars: 2000 });
    assert.equal(r.ok, true);
    assert.equal(r.truncated, true);
    assert.ok(r.mainText.length < 4000, '截断后不应远超上限，实际 ' + r.mainText.length);
    assert.ok(r.mainText.includes('内容已截断'), '应有截断提示');
    assert.ok(r.rawCharCount > r.mainText.length);
    assert.ok(r.mainText.includes('第 40 段'), '视口所在段落应在截断后补回');
    assert.ok(r.mainText.includes('用户当前视口内的内容'));
  } finally {
    env.cleanup();
  }
});

test('选中文本会被单独提取', () => {
  const env = setup(`<html><head><title>选区</title></head><body>
    <p id="sel">这段是我选中的重点内容。</p>
    <p>这段没被选中，只是普通正文。</p>
  </body></html>`);
  try {
    const win = env.win;
    const range = win.document.createRange();
    range.selectNodeContents(win.document.getElementById('sel'));
    win.getSelection().addRange(range);

    const r = revive()({ maxChars: 5000 });
    assert.equal(r.ok, true);
    assert.equal(r.selection, '这段是我选中的重点内容。');
  } finally {
    env.cleanup();
  }
});

test('空页面返回 ok=false 且带原因', () => {
  const env = setup('<html><head><title>空</title></head><body></body></html>');
  try {
    const r = revive()({ maxChars: 5000 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'NO_TEXT_EXTRACTED');
  } finally {
    env.cleanup();
  }
});

test('极端参数不会崩溃（maxChars 过小被夹紧）', () => {
  const env = setup(longArticleHtml(), { layout: true });
  try {
    const r = revive()({ maxChars: 1 });
    assert.equal(r.ok, true);
    assert.ok(r.mainText.length >= 100, '下限应被夹到 2000 字符级别');
  } finally {
    env.cleanup();
  }
});

test('重复块会去重（嵌套 li>p 场景）', () => {
  const html = `<html><head><title>去重</title></head><body><article>
    <ul><li><p>这是会被重复抓到的同一句话</p></li></ul>
    <p>这是另一句独立的话。</p>
  </article></body></html>`;
  const env = setup(html);
  try {
    const r = revive()({ maxChars: 5000 });
    const occurrences = r.mainText.split('这是会被重复抓到的同一句话').length - 1;
    assert.equal(occurrences, 1, '同一段文本不应重复出现');
  } finally {
    env.cleanup();
  }
});
