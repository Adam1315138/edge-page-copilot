/**
 * 页面正文提取器。
 *
 * ⚠️ 约束：本函数会被 chrome.scripting.executeScript({ func }) 序列化后注入页面执行，
 * 因此函数体内 **不得引用任何模块作用域变量 / import**，所有辅助函数必须在内部定义。
 * 测试用例会通过 toString() + eval 的方式验证这一点（模拟浏览器注入）。
 */
export function extractPageContext(options) {
  const opt = options || {};
  const maxChars = Math.min(60000, Math.max(2000, Number(opt.maxChars) || 24000));
  const viewportMax = Math.min(12000, Math.max(500, Number(opt.viewportMax) || 6000));
  const maxBlocks = Math.min(8000, Math.max(200, Number(opt.maxBlocks) || 4000));

  const doc = document;
  const win = window;

  const result = {
    ok: false,
    url: '',
    title: '',
    siteName: '',
    description: '',
    selection: '',
    viewportText: '',
    mainText: '',
    charCount: 0,
    rawCharCount: 0,
    blockCount: 0,
    truncated: false,
    hasLayout: false,
    reason: ''
  };

  const SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, SVG: 1, CANVAS: 1, IFRAME: 1,
    TEMPLATE: 1, HEAD: 1, SELECT: 1, TEXTAREA: 1, INPUT: 1, BUTTON: 1, FORM: 1
  };
  const NOISE_TAGS = { NAV: 1, FOOTER: 1 };
  const BLOCK_SELECTOR = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,td,th,figcaption,dt,dd,summary';
  const NOISE_RE = /(^|[\s_-])(nav|navbar|menu|breadcrumb|footer|sidebar|side-bar|comment|comments|share|social|advert|ads|ad|promo|cookie|banner|popup|modal|subscribe|newsletter|related|recommend)([\s_-]|$)/i;

  try {
    result.url = String((win.location && win.location.href) || '');
    result.title = String(doc.title || '').trim();

    const metaDesc = doc.querySelector('meta[name="description"], meta[property="og:description"]');
    if (metaDesc) result.description = String(metaDesc.getAttribute('content') || '').trim();

    const ogSite = doc.querySelector('meta[property="og:site_name"]');
    if (ogSite) result.siteName = String(ogSite.getAttribute('content') || '').trim();

    try {
      const sel = win.getSelection ? win.getSelection() : null;
      if (sel) {
        const s = String(sel).replace(/\u00a0/g, ' ').trim();
        if (s) result.selection = s.slice(0, 8000);
      }
    } catch (e) { /* selection 不可用时忽略 */ }

    if (!doc.body) {
      result.reason = 'EMPTY_BODY';
      return result;
    }

    // jsdom 等无布局环境下 body 尺寸为 0，此时跳过所有基于 rect 的可见性/视口判断。
    let bodyRect = null;
    try { bodyRect = doc.body.getBoundingClientRect(); } catch (e) { bodyRect = null; }
    const hasLayout = !!(bodyRect && (bodyRect.width > 0 || bodyRect.height > 0));
    result.hasLayout = hasLayout;
    const vh = hasLayout ? Number(win.innerHeight) || 800 : 0;

    function attrOf(el, name) {
      if (!el || !el.getAttribute) return '';
      return String(el.getAttribute(name) || '');
    }

    function classSig(el) {
      let cls = '';
      let id = '';
      if (el) {
        if (typeof el.className === 'string') cls = el.className;
        else cls = attrOf(el, 'class');
        id = attrOf(el, 'id');
      }
      return (cls + ' ' + id).toLowerCase();
    }

    function isHidden(el) {
      if (!el || el.nodeType !== 1) return true;
      if (el.hidden) return true;
      if (attrOf(el, 'aria-hidden') === 'true') return true;
      // 内联样式不需要布局信息即可判断，先查（也让无布局环境下的测试可复现）
      const inline = attrOf(el, 'style');
      if (inline && /(display\s*:\s*none|visibility\s*:\s*hidden)/i.test(inline)) return true;
      if (!hasLayout) return false; // 无布局环境不做视觉判断
      let cs = null;
      try { cs = win.getComputedStyle(el); } catch (e) { cs = null; }
      if (cs) {
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return true;
        if (cs.opacity !== '' && Number(cs.opacity) === 0) return true;
      }
      let r = null;
      try { r = el.getBoundingClientRect(); } catch (e) { r = null; }
      if (r && r.width === 0 && r.height === 0) return true;
      return false;
    }

    function hasBadAncestor(el, root) {
      let cur = el;
      let depth = 0;
      while (cur && cur !== root && depth < 12) {
        if (cur.nodeType === 1) {
          if (SKIP_TAGS[cur.tagName]) return true;
          if (isHidden(cur)) return true;
        }
        cur = cur.parentNode;
        depth += 1;
      }
      return false;
    }

    function isNoise(el, root) {
      let cur = el;
      let depth = 0;
      while (cur && cur !== root.parentNode && depth < 10) {
        if (cur.nodeType === 1) {
          if (NOISE_TAGS[cur.tagName]) return true;
          if (NOISE_RE.test(classSig(cur))) return true;
        }
        cur = cur.parentNode;
        depth += 1;
      }
      return false;
    }

    // ---- 1. 选取正文根容器（文本最长者，太短则退回 body） ----
    const CANDIDATE_SELECTOR = [
      'article', 'main', '[role="main"]',
      '.markdown-body', '.article-content', '.post-content', '.entry-content',
      '.article-body', '.content-body', '#content', '#main', 'article .content'
    ].join(',');

    let root = doc.body;
    let bestLen = -1;
    let cands = [];
    try { cands = doc.querySelectorAll(CANDIDATE_SELECTOR); } catch (e) { cands = []; }
    for (let i = 0; i < cands.length; i += 1) {
      const c = cands[i];
      if (hasBadAncestor(c, doc.body)) continue;
      const len = String(c.textContent || '').length;
      if (len > bestLen) {
        bestLen = len;
        root = c;
      }
    }
    if (bestLen < 500) root = doc.body;

    // ---- 2. 收集块级文本 ----
    let nodes = [];
    try { nodes = root.querySelectorAll(BLOCK_SELECTOR); } catch (e) { nodes = []; }

    const seen = new Set();
    const allParts = [];
    const vpParts = [];
    let allLen = 0;
    let usedBlocks = 0;
    let firstViewportPart = '';

    for (let i = 0; i < nodes.length; i += 1) {
      if (usedBlocks >= maxBlocks) break;
      const el = nodes[i];
      const tag = el.tagName;

      if (SKIP_TAGS[tag]) continue;
      if (hasBadAncestor(el, root)) continue;

      let text;
      if (tag === 'PRE') {
        text = String(el.textContent || '').replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
        if (text.length > 4000) text = text.slice(0, 4000) + ' …';
      } else {
        text = String(el.textContent || '').replace(/[\s\u00a0]+/g, ' ').trim();
      }
      if (text.length < 2) continue;

      // 嵌套块去重（<li><p>x</p></li> 之类）
      const dedupeKey = text.length > 120 ? text.slice(0, 120) + '#' + text.length : text;
      if (seen.has(dedupeKey)) continue;

      // 噪音容器内的短文本直接丢弃（长文本可能是误判的正文，保留）
      const isHeading = tag === 'H1' || tag === 'H2' || tag === 'H3' || tag === 'H4' || tag === 'H5' || tag === 'H6';
      if (text.length < 40 && !isHeading && isNoise(el, root)) continue;

      seen.add(dedupeKey);
      usedBlocks += 1;

      let line;
      if (tag === 'LI') line = '- ' + text;
      else if (isHeading) line = (tag === 'H1' ? '# ' : '## ') + text;
      else if (tag === 'BLOCKQUOTE') line = '> ' + text;
      else if (tag === 'PRE') line = '```\n' + text + '\n```';
      else line = text;

      const chunk = line + '\n\n';
      allParts.push(chunk);
      allLen += chunk.length;

      let inViewport = false;
      if (hasLayout) {
        try {
          const r = el.getBoundingClientRect();
          inViewport = r.bottom > 0 && r.top < vh;
        } catch (e) { inViewport = false; }
      }
      if (inViewport) {
        vpParts.push(line + '\n');
        if (!firstViewportPart) firstViewportPart = text.slice(0, 60);
      }

      // 视口内容全部收齐且全文已远超上限时可提前结束（视口通常在文档中段，因此只在越界后继续)
      if (allLen > maxChars * 2 && vpParts.length > 0) break;
    }

    let mainText = allParts.join('');
    const rawLen = mainText.length;
    result.rawCharCount = rawLen;

    if (mainText.length > maxChars) {
      mainText = mainText.slice(0, maxChars);
      result.truncated = true;
      let vpText = vpParts.join('');
      if (vpText.length > viewportMax) vpText = vpText.slice(0, viewportMax);
      // 视口内容若被截断掉，补回到尾部，保证「用户正在看的部分」不丢
      if (vpText && firstViewportPart && mainText.indexOf(firstViewportPart) === -1) {
        mainText += '\n\n[以下是用户当前视口内的内容]\n' + vpText;
      }
      mainText += '\n\n[内容已截断：原文共 ' + rawLen + ' 字符，此处保留前 ' + maxChars + ' 字符]';
    }

    let viewportText = vpParts.join('');
    if (viewportText.length > viewportMax) viewportText = viewportText.slice(0, viewportMax) + '…';

    result.mainText = mainText.trim();
    result.viewportText = viewportText.trim();
    result.blockCount = usedBlocks;
    result.charCount = result.mainText.length;
    result.ok = result.mainText.length > 0;
    if (!result.ok) result.reason = 'NO_TEXT_EXTRACTED';
    return result;
  } catch (err) {
    result.ok = false;
    result.reason = 'EXTRACT_ERROR: ' + (err && err.message ? err.message : String(err));
    return result;
  }
}
