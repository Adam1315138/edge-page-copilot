/**
 * 轻量 Markdown 渲染器（无第三方依赖）。
 *
 * 安全前提：模型输出属于不可信内容，因此所有文本先做 HTML 转义再套标签，
 * 链接只放行 http/https/mailto，杜绝 javascript: / data: 注入。
 */

export function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

export function sanitizeUrl(raw) {
  const url = String(raw || '').trim();
  if (!url) return '';
  if (/^(https?:\/\/|mailto:)/i.test(url)) return url;
  if (/^\/\//.test(url)) return 'https:' + url;
  return '';
}

function renderInline(raw) {
  const codes = [];
  let s = String(raw == null ? '' : raw).replace(/`([^`\n]+)`/g, (m, code) => {
    codes.push(code);
    return '\u0000CODE' + (codes.length - 1) + '\u0000';
  });

  s = escapeHtml(s);

  // 链接 [text](url)
  s = s.replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (m, label, href) => {
    const safe = sanitizeUrl(href.replace(/&amp;/g, '&'));
    if (!safe) return label;
    return '<a href="' + escapeHtml(safe) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
  });

  // 裸链接自动识别（跳过已生成的 <a> 内部，用简单策略：只在非标签片段中匹配）
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m, prefix, url) => {
    return prefix + '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">' + url + '</a>';
  });

  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w])__([^_]+)__(?!\w)/g, '$1<strong>$2</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  s = s.replace(/\u0000CODE(\d+)\u0000/g, (m, idx) => {
    const code = codes[Number(idx)];
    if (code === undefined) return m;
    return '<code>' + escapeHtml(code) + '</code>';
  });

  return s;
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

/**
 * @param {string} source
 * @returns {string} HTML 片段
 */
export function renderMarkdown(source) {
  const text = String(source == null ? '' : source).replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  let para = [];
  let listType = null; // 'ul' | 'ol'

  const flushPara = () => {
    if (para.length === 0) return;
    const html = renderInline(para.join('\n')).replace(/\n/g, '<br>');
    out.push('<p>' + html + '</p>');
    para = [];
  };

  const closeList = () => {
    if (listType) {
      out.push('</' + listType + '>');
      listType = null;
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // 代码块
    const fence = line.match(/^\s*```([\w+-]*)\s*$/);
    if (fence) {
      flushPara();
      closeList();
      const lang = fence[1] || '';
      const buf = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1; // 跳过结束围栏
      const cls = lang ? ' class="language-' + escapeHtml(lang) + '"' : '';
      out.push('<pre><code' + cls + '>' + escapeHtml(buf.join('\n')) + '</code></pre>');
      continue;
    }

    // 空行
    if (!line.trim()) {
      flushPara();
      closeList();
      i += 1;
      continue;
    }

    // 标题
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushPara();
      closeList();
      const level = heading[1].length;
      out.push('<h' + level + '>' + renderInline(heading[2]) + '</h' + level + '>');
      i += 1;
      continue;
    }

    // 分隔线
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      flushPara();
      closeList();
      out.push('<hr>');
      i += 1;
      continue;
    }

    // 表格
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushPara();
      closeList();
      const header = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      let table = '<table><thead><tr>' + header.map((h) => '<th>' + renderInline(h) + '</th>').join('') + '</tr></thead><tbody>';
      for (const row of rows) {
        table += '<tr>' + header.map((_, idx) => '<td>' + renderInline(row[idx] || '') + '</td>').join('') + '</tr>';
      }
      table += '</tbody></table>';
      out.push(table);
      continue;
    }

    // 引用
    if (/^>\s?/.test(line)) {
      flushPara();
      closeList();
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i += 1;
      }
      out.push('<blockquote>' + renderInline(buf.join('\n')).replace(/\n/g, '<br>') + '</blockquote>');
      continue;
    }

    // 列表
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const want = ul ? 'ul' : 'ol';
      if (listType && listType !== want) closeList();
      if (!listType) {
        out.push('<' + want + '>');
        listType = want;
      }
      out.push('<li>' + renderInline((ul || ol)[1]) + '</li>');
      i += 1;
      continue;
    }

    // 普通段落
    closeList();
    para.push(line);
    i += 1;
  }

  flushPara();
  closeList();
  return out.join('\n');
}
