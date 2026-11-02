/**
 * PDF 文本重组测试。
 * PDF 的文本层是带坐标的碎片，这层错了就会出现「单词被拆开」「整段粘连」这类问题。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { itemsToLines, linesToText, pagesToText, summarizeText } from '../src/lib/pdf-text.js';

/** 构造一个 pdf.js 风格的 text item */
function item(str, x, y, width, opts = {}) {
  const height = opts.height || 12;
  return {
    str,
    transform: [height, 0, 0, height, x, y],
    width: width == null ? str.length * 6 : width,
    height,
    hasEOL: !!opts.hasEOL
  };
}

/* ---------------- 碎片 → 行 ---------------- */

test('同一 y 的碎片合并成一行，间隙大时补空格', () => {
  const lines = itemsToLines([
    item('Hello', 10, 100, 30),
    item('World', 45, 100, 30)
  ]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'Hello World');
});

test('间隙很小不补空格（避免 word 被拆）', () => {
  const lines = itemsToLines([
    item('Hel', 10, 100, 18),
    item('lo', 28, 100, 12)
  ]);
  assert.equal(lines[0].text, 'Hello');
});

test('中文之间不补空格', () => {
  const lines = itemsToLines([
    item('中文', 10, 100, 24),
    item('内容', 45, 100, 24)
  ]);
  assert.equal(lines[0].text, '中文内容');
});

test('中英混排时中文与英文之间补空格', () => {
  const lines = itemsToLines([
    item('使用', 10, 100, 24),
    item('API', 45, 100, 20)
  ]);
  assert.equal(lines[0].text, '使用 API');
});

test('不同 y 拆成不同行', () => {
  const lines = itemsToLines([
    item('第一行', 10, 100),
    item('第二行', 10, 86)
  ]);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, '第一行');
  assert.equal(lines[1].text, '第二行');
});

test('hasEOL 强制换行', () => {
  const lines = itemsToLines([
    item('A', 10, 100, 10, { hasEOL: true }),
    item('B', 30, 100, 10)
  ]);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, 'A');
  assert.equal(lines[1].text, 'B');
});

test('纯空白 item 作为空格标记，不产生空行', () => {
  const lines = itemsToLines([
    item('foo', 10, 100, 20),
    item('   ', 30, 100, 10),
    item('bar', 40, 100, 20)
  ]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'foo bar');
});

test('空 items 数组返回空结果，不抛错', () => {
  assert.deepEqual(itemsToLines([]), []);
  assert.deepEqual(itemsToLines(null), []);
});

/* ---------------- 行 → 段落 ---------------- */

test('英文硬换行会合并成一段并补空格', () => {
  const lines = [
    { text: 'This is a very long', y: 100, height: 12 },
    { text: 'sentence that wrapped.', y: 86, height: 12 }
  ];
  assert.equal(linesToText(lines), 'This is a very long sentence that wrapped.');
});

test('中文硬换行合并时不加空格', () => {
  const lines = [
    { text: '这是一段很长的中文', y: 100, height: 12 },
    { text: '内容被换行切开了', y: 86, height: 12 }
  ];
  assert.equal(linesToText(lines), '这是一段很长的中文内容被换行切开了');
});

test('上一行以句号结尾时保留分段', () => {
  const lines = [
    { text: '第一句结束。', y: 100, height: 12 },
    { text: '第二句开始。', y: 86, height: 12 }
  ];
  assert.equal(linesToText(lines), '第一句结束。\n第二句开始。');
});

test('行距明显变大时插入空行（段落间隔）', () => {
  const lines = [
    { text: '第一段内容', y: 100, height: 12 },
    { text: '第二段内容', y: 60, height: 12 }
  ];
  assert.equal(linesToText(lines), '第一段内容\n\n第二段内容');
});

test('列表项不会被合并到上一行', () => {
  const lines = [
    { text: '概述如下', y: 100, height: 12 },
    { text: '- 第一点', y: 86, height: 12 },
    { text: '- 第二点', y: 72, height: 12 }
  ];
  const text = linesToText(lines);
  assert.ok(text.includes('概述如下\n- 第一点'), '实际: ' + JSON.stringify(text));
  assert.ok(text.includes('- 第二点'));
});

test('数字编号列表同样不合并', () => {
  const lines = [
    { text: '步骤如下：', y: 100, height: 12 },
    { text: '1. 打开设置', y: 86, height: 12 }
  ];
  assert.ok(linesToText(lines).includes('\n1. 打开设置'));
});

test('空行与纯空白行被忽略', () => {
  const lines = [
    { text: '   ', y: 120, height: 12 },
    { text: '正文', y: 100, height: 12 },
    { text: '', y: 80, height: 12 }
  ];
  assert.equal(linesToText(lines), '正文');
});

test('自适应行距：中文大行距（1.9 倍）不会被误判成段落间隔', () => {
  // 真机上报过的问题：中文排版行距大，写死 1.75 倍阈值会把一段话拆成好几段
  const lines = [
    { text: '这是一份用于验证中文文本提取的测试文档。深度学习模型的推理成本主要由注意力机制', y: 700, height: 13 },
    { text: '的计算量决定，因此在长文本场景下需要采用稀疏注意力或分块缓存策略。', y: 675, height: 13 },
    { text: '第二段：本节讨论大语言模型的上下文窗口管理。', y: 650, height: 13 },
    { text: '当输入超过窗口长度时，常见做法是滑动窗口、摘要压缩。', y: 625, height: 13 }
  ];
  const text = linesToText(lines);
  assert.ok(!text.includes('\n\n'), '均匀行距不该产生段落间隔，实际: ' + JSON.stringify(text));
  assert.ok(text.includes('注意力机制的计算量决定'), '中文续行应无缝连接，实际: ' + JSON.stringify(text));
});

test('自适应行距：明显更大的间隔仍然识别为段落', () => {
  const lines = [
    { text: '第一段第一行内容', y: 700, height: 13 },
    { text: '第一段第二行内容', y: 675, height: 13 },
    { text: '第一段第三行内容', y: 650, height: 13 },
    { text: '第二段开头内容', y: 600, height: 13 },
    { text: '第二段第二行', y: 575, height: 13 }
  ];
  const text = linesToText(lines);
  assert.ok(text.includes('\n\n'), '段落间隔应保留，实际: ' + JSON.stringify(text));
  assert.ok(text.indexOf('第二段开头') > text.indexOf('第一段第三行'));
});

/* ---------------- 多页 ---------------- */

test('pagesToText 带页码标记', () => {
  const text = pagesToText([
    { pageNumber: 1, lines: [{ text: '第一页内容。', y: 100, height: 12 }] },
    { pageNumber: 2, lines: [{ text: '第二页内容。', y: 100, height: 12 }] }
  ]);
  assert.ok(text.includes('[第 1 页]'));
  assert.ok(text.includes('[第 2 页]'));
  assert.ok(text.indexOf('[第 1 页]') < text.indexOf('[第 2 页]'));
});

test('空白页被跳过，不产生空页码', () => {
  const text = pagesToText([
    { pageNumber: 1, lines: [{ text: '有内容', y: 100, height: 12 }] },
    { pageNumber: 2, lines: [] },
    { pageNumber: 3, lines: [{ text: '也有内容', y: 100, height: 12 }] }
  ]);
  assert.ok(!text.includes('[第 2 页]'));
  assert.ok(text.includes('[第 3 页]'));
});

/* ---------------- 统计 ---------------- */

test('summarizeText 识别中文比例', () => {
  const cn = summarizeText('这是一段中文内容，很长很长。');
  assert.ok(cn.looksChinese);
  assert.ok(cn.cjkRatio > 0.5);

  const en = summarizeText('This is an English paragraph.');
  assert.equal(en.looksChinese, false);
  assert.ok(en.cjkRatio === 0);
});

test('summarizeText 处理空输入', () => {
  const empty = summarizeText('');
  assert.equal(empty.chars, 0);
  assert.equal(empty.looksChinese, false);
});
