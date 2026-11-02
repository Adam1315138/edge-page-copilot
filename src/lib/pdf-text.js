/**
 * PDF 文本重组（纯函数，无 pdf.js 依赖，可单测）。
 *
 * PDF 的文本层不是一个完整字符串，而是一堆带坐标的碎片（item）。
 * 这里要做的是：碎片 → 行 → 段落，并且在中英文两种排版下都别把词拆开。
 */

const CJK_RE = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;
const SENTENCE_END = /[.。!！?？;；:："'”』」)\]】、，,]$/;
const LIST_START = /^([-*•·▪◦●○]|\d{1,2}[.)、]|[（(]\d+[）)]|[一二三四五六七八九十]+[、.)])\s*/;

function isCjkChar(ch) {
  return !!ch && CJK_RE.test(ch);
}

function endsWithCjk(str) {
  return isCjkChar(str.slice(-1));
}

function startsWithCjk(str) {
  return isCjkChar(str.slice(0, 1));
}

/**
 * 把一页的 textContent.items 聚成行。
 * @returns {Array<{text:string, x:number, y:number, height:number}>}
 */
export function itemsToLines(items, opts = {}) {
  const yTolerance = opts.yTolerance || 3;
  const lines = [];
  let cur = null;
  let pendingSpace = false;

  const pushLine = () => {
    if (!cur) return;
    const text = cur.parts.map((p) => p.str).join('');
    if (text.trim().length > 0) {
      lines.push({ text, x: cur.x, y: cur.y, height: cur.height });
    }
    cur = null;
    pendingSpace = false;
  };

  for (const item of items || []) {
    if (!item || typeof item.str !== 'string') continue;

    const transform = item.transform || [1, 0, 0, 1, 0, 0];
    const x = Number(transform[4]) || 0;
    const y = Number(transform[5]) || 0;
    const height = Math.abs(Number(item.height) || Number(transform[3]) || 12) || 12;
    const str = item.str;

    // 容差按字号算：上标/下标会偏离基线几个点，但它们仍是同一行；
    // 写死固定容差会把 "Author∗" 拆成 "Author" 和 "∗" 两行。
    if (cur) {
      const tol = Math.max(yTolerance, Math.max(cur.height, height) * 0.5);
      if (Math.abs(cur.y - y) > tol) {
        pushLine();
        cur = { x, y, height, parts: [] };
      }
    } else {
      cur = { x, y, height, parts: [] };
    }

    // 纯空白 item：只记一个"这里该有空格"的标记
    if (str.trim().length === 0) {
      if (cur.parts.length > 0) pendingSpace = true;
      if (item.hasEOL) pushLine();
      continue;
    }

    if (cur.parts.length > 0) {
      const prev = cur.parts[cur.parts.length - 1];
      const gap = x - (prev.x + prev.width);
      const threshold = Math.max(1.2, height * 0.22);
      const prevEndsCjk = endsWithCjk(prev.str);
      const curStartsCjk = startsWithCjk(str);

      let needSpace = pendingSpace || gap > threshold;
      // 中文之间靠字距排版，不补空格；中英混排才补
      if (prevEndsCjk && curStartsCjk) needSpace = false;

      if (needSpace && !/\s$/.test(prev.str) && !/^\s/.test(str)) {
        cur.parts.push({ str: ' ', x, width: 0, synthetic: true });
      }
    }

    pendingSpace = false;
    cur.parts.push({ str, x, width: Number(item.width) || 0 });

    if (item.hasEOL) pushLine();
  }

  pushLine();
  return lines;
}

/**
 * 行 → 段落文本。
 *
 * 段落判定要同时看三件事，只看行距会在真机上翻车：
 *   1. 字号明显不同 → 一定是不同层级（标题 / 正文 / 图注），必须分段
 *   2. 左缩进差得多 → 列表项或独立块，分段
 *   3. 行距明显超过该页的典型行距 → 段落间隔（用比例中位数自适应，不写死倍数）
 *
 * 之前只用固定 1.75 倍行距，中文排版（1.9 倍行距）会被整段拆散；
 * 只用全页中位数又会让标题行距误判成段落。
 */
export function linesToText(lines, opts = {}) {
  const mergeHardBreaks = opts.mergeHardBreaks !== false;
  const list = (lines || []).filter((l) => String(l.text || '').trim());
  if (list.length === 0) return '';

  const heightOf = (l) => Number(l.height) || 12;

  // 行距 / 字号 的比例中位数，用来适应不同排版的紧凑程度
  const ratios = [];
  for (let i = 1; i < list.length; i += 1) {
    const gap = Math.abs(Number(list[i - 1].y || 0) - Number(list[i].y || 0));
    if (gap > 0.5) ratios.push(gap / heightOf(list[i - 1]));
  }
  const sorted = ratios.slice().sort((a, b) => a - b);
  const medianRatio = sorted.length >= 3 ? sorted[Math.floor(sorted.length / 2)] : 0;
  const gapThreshold = medianRatio > 0 ? medianRatio * 1.45 : 1.75;

  const isBlockBreak = (prev, cur) => {
    const hPrev = heightOf(prev);
    const hCur = heightOf(cur);

    // 1. 字号层级不同（标题 / 正文 / 图注）
    //    注意不用缩进判断：居中的多行标题每行 x 都不同，会被误拆成多段
    const sizeRatio = hPrev / hCur;
    if (sizeRatio > 1.15 || sizeRatio < 0.85) return true;

    // 2. 行距明显超过该页典型行距
    const gap = Math.abs(Number(prev.y || 0) - Number(cur.y || 0));
    return (gap / hPrev) > gapThreshold;
  };

  const out = [];
  let prev = null;

  for (const line of list) {
    const text = String(line.text || '').replace(/[ \t\u00a0]+/g, ' ').trim();
    if (!text) continue;

    if (prev && out.length > 0) {
      if (isBlockBreak(prev, line)) {
        out.push('');
      } else if (mergeHardBreaks) {
        const lastIdx = out.length - 1;
        const lastLine = out[lastIdx];
        const isListItem = LIST_START.test(text);
        const prevEnded = SENTENCE_END.test(lastLine);
        if (!prevEnded && !isListItem && lastLine.length > 0) {
          // 同一段的续行：中文直接接，英文补空格
          const glue = endsWithCjk(lastLine) || startsWithCjk(text) ? '' : ' ';
          out[lastIdx] = lastLine + glue + text;
          prev = line;
          continue;
        }
      }
    }

    out.push(text);
    prev = line;
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 多页 → 带页码标记的全文。
 * @param {Array<{pageNumber:number, lines:Array}>} pages
 */
export function pagesToText(pages, opts = {}) {
  const parts = [];
  for (const page of pages || []) {
    const body = linesToText(page.lines, opts);
    if (!body) continue;
    parts.push('[第 ' + page.pageNumber + ' 页]\n' + body);
  }
  return parts.join('\n\n');
}

/**
 * 统计文本信息，用于给模型一个"这是什么文档"的印象。
 */
export function summarizeText(text) {
  const clean = String(text || '');
  const chars = clean.length;
  const cjk = (clean.match(/[\u2e80-\u9fff]/g) || []).length;
  const lines = clean.split('\n').filter((l) => l.trim()).length;
  return {
    chars,
    lines,
    cjkRatio: chars > 0 ? cjk / chars : 0,
    looksChinese: chars > 0 && cjk / chars > 0.15
  };
}
