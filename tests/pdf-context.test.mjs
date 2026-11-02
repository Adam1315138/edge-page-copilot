/**
 * PDF 上下文构造测试。
 *
 * 核心回归：「问第 52 页答不出来」——页码必须被强制选中，
 * 否则超长文档按关键词挑页时会漏掉用户明确要的那页。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractKeywords,
  extractPageNumbers,
  parsePageIndex,
  scorePageText,
  selectPages,
  buildPdfContext
} from '../src/lib/pdf-context.js';
import { estimateTokens } from '../src/lib/util.js';

/** 造一份多页文档，每页有可区分的标记词 */
function makeDoc({ pages = 60, charsPerPage = 1200, mark = () => '' } = {}) {
  const parts = [];
  for (let i = 1; i <= pages; i += 1) {
    const extra = mark(i) || '';
    const body = ('第' + i + '页正文内容，讨论主题与细节。' + extra).repeat(Math.ceil(charsPerPage / 20));
    parts.push('[第 ' + i + ' 页]\n' + body.slice(0, charsPerPage));
  }
  return parts.join('\n\n');
}

/* ---------------- 关键词与页码 ---------------- */

test('extractKeywords 抽取英文词并过滤停用词', () => {
  const kws = extractKeywords('What is the main idea of this document?');
  assert.ok(kws.includes('idea'));
  assert.ok(!kws.includes('the'), '停用词应被过滤');
  assert.ok(!kws.includes('document'), '文档类泛词应被过滤');
});

test('extractKeywords 中文按 2-gram 切分', () => {
  const kws = extractKeywords('注意力机制是怎么工作的');
  assert.ok(kws.includes('注意'), '实际: ' + JSON.stringify(kws));
  assert.ok(kws.includes('机制'));
  assert.ok(!kws.includes('怎么'), '停用词应被过滤');
});

test('extractPageNumbers 支持中英两种写法', () => {
  assert.deepEqual(extractPageNumbers('第 52 页讲了什么'), [52]);
  assert.deepEqual(extractPageNumbers('page 12 的内容'), [12]);
  assert.deepEqual(extractPageNumbers('P7 是什么'), [7]);
  assert.deepEqual(extractPageNumbers('第3页和第8页'), [3, 8]);
  assert.deepEqual(extractPageNumbers('没有页码'), []);
});

/* ---------------- 页索引与打分 ---------------- */

test('parsePageIndex 正确切出每页范围与首行', () => {
  const doc = '[第 1 页]\n标题A\n内容A\n\n[第 2 页]\n标题B\n内容B';
  const index = parsePageIndex(doc);
  assert.equal(index.length, 2);
  assert.equal(index[0].n, 1);
  assert.equal(index[0].head, '标题A');
  assert.equal(index[1].n, 2);
  assert.ok(index[0].start < index[1].start);
  assert.equal(index[1].end, doc.length);
});

test('scorePageText 命中越多分越高', () => {
  const kws = ['注意力', '机制'];
  const low = scorePageText('这段提到了注意力一次。', kws);
  const high = scorePageText('注意力机制的注意力机制，注意力机制。', kws);
  assert.ok(high > low);
  assert.equal(scorePageText('完全无关的内容', kws), 0);
});

/* ---------------- 选页 ---------------- */

test('明确提到页码的页必定被选中（核心回归）', () => {
  const doc = makeDoc({ pages: 60, charsPerPage: 1200 });
  const picked = selectPages(doc, null, '第 52 页讲了什么', 20000);

  assert.ok(picked.pages.includes(52), '第 52 页必须被选中，实际: ' + JSON.stringify(picked.pages));
  assert.ok(picked.text.includes('[第 52 页]'), '正文里必须包含第 52 页原文');
});

test('关键词命中的页会被选中', () => {
  const doc = makeDoc({
    pages: 60,
    mark: (i) => (i === 30 ? '这里出现了独特术语 QuantumFoam 的东西。' : '')
  });
  const picked = selectPages(doc, null, 'QuantumFoam 是什么意思', 20000);
  assert.ok(picked.pages.includes(30), '实际: ' + JSON.stringify(picked.pages));
});

test('目录始终包含全部页（模型能知道文档结构）', () => {
  const doc = makeDoc({ pages: 40 });
  const picked = selectPages(doc, null, '第 5 页', 8000);
  assert.ok(picked.text.includes('[文档目录'), '应包含目录');
  assert.ok(picked.text.includes('第 40 页:'), '目录应覆盖到最后一页');
});

test('预算极小也不会返回空（至少给首页）', () => {
  const doc = makeDoc({ pages: 30 });
  const picked = selectPages(doc, null, '毫不相关的问句', 4000);
  assert.ok(picked.text.length > 0, '不能返回空文本');
  assert.ok(picked.pages.length >= 1);
});

/* ---------------- 主入口 ---------------- */

test('文档装得下时整本返回，不做挑选', () => {
  const doc = makeDoc({ pages: 3, charsPerPage: 500 });
  const r = buildPdfContext({ fullText: doc, question: '第 2 页讲了什么', budgetTokens: 40000 });
  assert.equal(r.mode, 'full');
  assert.ok(r.mainText.includes('[第 3 页]'), '整本都要在');
  assert.equal(r.needsFullRead, false);
});

test('超预算 + 具体页码 → selected 模式且含该页', () => {
  const doc = makeDoc({ pages: 60, charsPerPage: 1200 });
  const r = buildPdfContext({ fullText: doc, question: '帮我翻译第 52 页', budgetTokens: 20000 });

  assert.equal(r.mode, 'selected');
  assert.ok(r.mainText.includes('[第 52 页]'), '必须包含第 52 页');
  assert.equal(r.needsFullRead, false);
  assert.ok(r.note.includes('页'), '应给出覆盖说明');
});

test('超预算 + 总结全文 → 标记 needsFullRead', () => {
  const doc = makeDoc({ pages: 60, charsPerPage: 1200 });
  const r = buildPdfContext({ fullText: doc, question: '总结这份文档的主要内容', budgetTokens: 20000 });
  assert.equal(r.mode, 'needs-full-read');
  assert.equal(r.needsFullRead, true);
});

test('英文长文档在默认预算下一整本塞得下（不该被砍）', () => {
  // 模拟英文 82 页：每页约 1600 字符英文 → 13 万字符，但 token 只有 3 万多
  const parts = [];
  for (let i = 1; i <= 82; i += 1) {
    const body = 'This page discusses performance and correctness of the proposed approach in detail. '.repeat(20);
    parts.push('[第 ' + i + ' 页]\n' + body.slice(0, 1600));
  }
  const doc = parts.join('\n\n');
  const tokens = estimateTokens(doc);

  assert.ok(tokens < 40000, '英文 82 页应小于 4 万 token，实际 ' + tokens);
  const r = buildPdfContext({ fullText: doc, question: '第 80 页说了什么', budgetTokens: 40000 });
  assert.equal(r.mode, 'full');
  assert.ok(r.mainText.includes('[第 82 页]'), '最后一页也要在');
});

test('页码超出文档范围时不会崩，也不硬塞', () => {
  const doc = makeDoc({ pages: 10 });
  const r = buildPdfContext({ fullText: doc, question: '第 99 页讲了什么', budgetTokens: 6000 });
  assert.ok(r.mainText.length > 0);
  assert.ok(!r.mainText.includes('[第 99 页]'));
});

test('空文档安全返回', () => {
  const r = buildPdfContext({ fullText: '', question: '讲什么', budgetTokens: 20000 });
  assert.equal(r.mainText, '');
  assert.equal(r.totalTokens, 0);
});
