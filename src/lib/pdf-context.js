/**
 * PDF 上下文构造（纯函数，可单测）。
 *
 * 解决的问题：82 页的 PDF 塞不进一次请求，粗暴砍掉后半本等于没读。
 * 这里的策略：
 *   1. 算得下就整本塞（按 token 算，不是字符数 —— 英文 82 页其实装得下）
 *   2. 装不下就按问题关键词给每页打分，挑最相关的页 + 附上每页首行当目录
 *   3. 问的是「总结全文」这类需要全局视野的，标记 needsFullRead 交给分块阅读
 */

import { estimateTokens } from './util.js';

const EN_STOP = new Set((
  'the a an is are was were be been being do does did doing have has had having ' +
  'i you he she it we they me him her them my your his its our their ' +
  'this that these those and or but if then than so such as at by for from in into of ' +
  'on onto to with within without about above after again against all any because before ' +
  'below between both during each few more most other some no nor not only own same too ' +
  'very can will just should now what which who whom whose when where why how ' +
  'pdf document documents file files paper report'
).split(' '));

const ZH_STOP = new Set([
  '这个', '那个', '什么', '怎么', '如何', '为什么', '是否', '可以', '我们', '他们', '一个',
  '以及', '但是', '因为', '所以', '如果', '然后', '还有', '就是', '不是', '已经', '能够',
  '需要', '应该', '可能', '这些', '那些', '里面', '之间', '之后', '之前', '时候', '现在',
  '请问', '帮我', '一下', '主要', '内容', '文档', '文件', '这段', '那里', '这里'
]);

/** 需要通读全文才答得好的问题类型 */
const GLOBAL_QUESTION_RE = new RegExp([
  '总结', '概括', '摘要', '全文', '通篇', '整体', '梳理', '大纲', '讲了什么', '讲了啥',
  '主要(讲|说|内容|观点|结论)', '核心(观点|内容|结论)', '分几(部分|章|节)',
  'summar', 'overview', 'outline', 'main (idea|point|argument)', 'tl;?dr', 'what is this (about|document)'
].join('|'), 'i');

/** 从问题里抽关键词（英文按词，中文按 2-gram；长词权重更高） */
export function extractKeywords(question) {
  const q = String(question || '');
  const out = [];
  const seen = new Set();

  const add = (word) => {
    const key = word.toLowerCase();
    if (key.length < 2 || seen.has(key)) return;
    seen.add(key);
    out.push(key);
  };

  for (const m of q.matchAll(/[A-Za-z][A-Za-z0-9_+#.-]{1,}/g)) {
    if (!EN_STOP.has(m[0].toLowerCase())) add(m[0]);
  }

  for (const m of q.matchAll(/[\u4e00-\u9fa5]{2,}/g)) {
    const seg = m[0];
    if (seg.length <= 6 && !ZH_STOP.has(seg)) add(seg);
    for (let i = 0; i + 2 <= seg.length; i += 1) {
      const gram = seg.slice(i, i + 2);
      if (!ZH_STOP.has(gram)) add(gram);
    }
  }

  return out;
}

/** 问题里明确提到的页码 */
export function extractPageNumbers(question) {
  const out = new Set();
  const s = String(question || '');
  let m;
  const re1 = /第\s*(\d{1,3})\s*页/g;
  while ((m = re1.exec(s)) !== null) out.add(Number(m[1]));
  const re2 = /\b(?:page|p\.?)\s*(\d{1,3})\b/gi;
  while ((m = re2.exec(s)) !== null) out.add(Number(m[1]));
  return [...out].filter((n) => n > 0);
}

/** 一页文本对关键词的匹配分 */
export function scorePageText(text, keywords) {
  if (!keywords || keywords.length === 0) return 0;
  const lower = String(text || '').toLowerCase();
  let score = 0;

  for (const k of keywords) {
    let idx = 0;
    let hits = 0;
    while (hits < 12) {
      idx = lower.indexOf(k, idx);
      if (idx === -1) break;
      hits += 1;
      idx += k.length;
    }
    if (hits > 0) score += hits * Math.min(3, Math.max(1, k.length / 2));
  }

  return score;
}

function firstLineOf(chunk) {
  const body = String(chunk || '').replace(/^\[第\s*\d+\s*页\]\s*/, '');
  const line = body.split('\n').map((l) => l.trim()).find((l) => l.length > 0) || '';
  return line.length > 60 ? line.slice(0, 60) + '…' : line;
}

/** 从全文里按 [第 N 页] 标记还原页索引 */
export function parsePageIndex(fullText) {
  const text = String(fullText || '');
  const re = /\[第\s*(\d+)\s*页\]/g;
  const marks = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    marks.push({ n: Number(m[1]), start: m.index });
  }

  return marks.map((mark, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].start : text.length;
    return {
      n: mark.n,
      start: mark.start,
      end,
      head: firstLineOf(text.slice(mark.start, end))
    };
  });
}

function buildDirectory(pages) {
  const lines = ['[文档目录（每页首行）]'];
  for (const p of pages) {
    lines.push('第 ' + p.n + ' 页: ' + (p.head || '（无可读文本）'));
  }
  return lines.join('\n');
}

/**
 * 选页：按关键词打分取 top，直到预算用完。
 * @returns {{ text: string, pages: number[], hitCount: number }}
 */
export function selectPages(fullText, pageIndex, question, budgetTokens) {
  const budget = Math.max(4000, Number(budgetTokens) || 40000);
  const index = (pageIndex && pageIndex.length) ? pageIndex : parsePageIndex(fullText);
  const keywords = extractKeywords(question);
  const pinned = extractPageNumbers(question);

  const pages = index.map((p) => ({
    n: p.n,
    head: p.head,
    text: String(fullText || '').slice(p.start, p.end)
  }));

  const scored = pages.map((p) => ({
    page: p,
    score: scorePageText(p.text, keywords)
      + (pinned.includes(p.n) ? 1000 : 0)
      + (p.n === 1 ? 5 : 0)
  }));

  const ranked = scored.slice().sort((a, b) => b.score - a.score);

  const directory = buildDirectory(pages);
  let used = estimateTokens(directory);
  const picked = [];

  for (const item of ranked) {
    if (item.score <= 0) break; // 剩下的都没命中，不用再加
    const cost = estimateTokens(item.page.text);
    if (used + cost > budget) continue;
    picked.push(item.page);
    used += cost;
  }

  // 一页都没命中时，至少给首页（标题/摘要通常在第一页）
  if (picked.length === 0 && pages.length > 0) {
    const first = pages[0];
    if (estimateTokens(first.text) <= budget) {
      picked.push(first);
      used += estimateTokens(first.text);
    }
  }

  picked.sort((a, b) => a.n - b.n);

  const hitCount = scored.filter((s) => s.score > 0).length;
  const body = picked.map((p) => p.text.trim()).join('\n\n');

  return {
    text: picked.length ? directory + '\n\n' + body : '',
    pages: picked.map((p) => p.n),
    hitCount
  };
}

/**
 * 主入口：构造本次要注入的 PDF 上下文。
 *
 * @returns {{
 *   mode: 'full'|'selected'|'needs-full-read',
 *   mainText: string,
 *   pagesIncluded: number[],
 *   needsFullRead: boolean,
 *   totalTokens: number,
 *   note: string
 * }}
 */
export function buildPdfContext({ fullText, pageIndex, question, budgetTokens }) {
  const text = String(fullText || '');
  const budget = Math.max(4000, Number(budgetTokens) || 40000);
  const totalTokens = estimateTokens(text);
  const globalQuestion = GLOBAL_QUESTION_RE.test(String(question || ''));

  if (totalTokens <= budget) {
    return {
      mode: 'full',
      mainText: text,
      pagesIncluded: [],
      needsFullRead: false,
      totalTokens,
      note: ''
    };
  }

  const index = (pageIndex && pageIndex.length) ? pageIndex : parsePageIndex(text);
  const picked = selectPages(text, index, question, budget);

  // 需要全局视野，或几乎没命中任何页 → 交给分块阅读
  if (globalQuestion || picked.hitCount < 2) {
    return {
      mode: 'needs-full-read',
      mainText: picked.text,
      pagesIncluded: picked.pages,
      needsFullRead: true,
      totalTokens,
      note: ''
    };
  }

  const shown = picked.pages.slice(0, 12).join(', ') + (picked.pages.length > 12 ? ' …' : '');
  return {
    mode: 'selected',
    mainText: picked.text,
    pagesIncluded: picked.pages,
    needsFullRead: false,
    totalTokens,
    note: '文档共 ' + index.length + ' 页 / 约 ' + totalTokens + ' tokens，超过单次上限。'
      + '已按你的问题挑选第 ' + shown + ' 页，并附上全文档目录。'
      + '若需要别的内容，直接说页码或换个问法。'
  };
}
