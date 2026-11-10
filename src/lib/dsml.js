/**
 * DeepSeek DSML 工具调用标记的解析与清理。
 *
 * 背景：DeepSeek 的模型内部用 `<|DSML|>`（DeepSeek Markup Language）表达工具调用，
 * 官方 API 会转成结构化 tool_calls。但走第三方中转、或模型/参数变化时，
 * 这段标记会原样进 content，用户就看到一堆 `< | | | DSML | | | invoke ...>`。
 *
 * 做法：先把各种变体**归一化成 `«DSML»` / `«/DSML»`**，再做解析与删除。
 * 因为实测标记形态不稳定（管道个数不一定、`>` 有时被吃进后面的标签名），
 * 直接拿复杂正则去套很容易漏。
 */

// 开标记：<|DSML|> 或 < | | | DSML | | | （后者没有自己的 '>'，紧接标签名）
const TOKEN_SRC = '<\\s*[|\\s]*DSML[|\\s]*(?:>|(?=[A-Za-z_]))';
const CLOSE_SRC = '<\\s*\\/\\s*[|\\s]*DSML[|\\s]*(?:>|(?=[A-Za-z_]))';
const TOKEN_RE = new RegExp(TOKEN_SRC, 'i');

const OPEN = '«DSML»';
const CLOSE = '«/DSML»';

function normalize(text) {
  // 闭合标记必须先处理，否则会被开标记的正则吃掉前缀
  return String(text || '')
    .replace(new RegExp(CLOSE_SRC, 'gi'), CLOSE)
    .replace(new RegExp(TOKEN_SRC, 'gi'), OPEN);
}

/** 文本里是否出现了 DSML 标记 */
export function containsDsml(text) {
  const s = String(text || '');
  if (TOKEN_RE.test(s)) return true;
  return s.includes(OPEN);
}

/**
 * 从文本里提取工具调用。
 * @returns {Array<{id:string, type:string, function:{name:string, arguments:string}}>}
 */
export function extractDsmlCalls(text) {
  const src = normalize(text);
  if (!src.includes(OPEN)) return [];

  const invokeRe = new RegExp(OPEN + '\\s*invoke\\s+name\\s*=\\s*"([^"]+)"\\s*>', 'gi');
  const marks = [];
  let m;
  while ((m = invokeRe.exec(src)) !== null) {
    marks.push({ name: m[1], start: m.index, bodyStart: invokeRe.lastIndex });
  }
  if (marks.length === 0) return [];

  const calls = [];
  for (let i = 0; i < marks.length; i += 1) {
    const end = i + 1 < marks.length ? marks[i + 1].start : src.length;
    const body = src.slice(marks[i].bodyStart, end);
    calls.push({
      id: 'dsml_' + (i + 1) + '_' + Date.now(),
      type: 'function',
      function: {
        name: marks[i].name,
        arguments: JSON.stringify(parseParams(body))
      }
    });
  }
  return calls;
}

function parseParams(body) {
  const out = {};
  const paramRe = new RegExp(
    OPEN + '\\s*parameter\\s+name\\s*=\\s*"([^"]+)"([^>]*)>([\\s\\S]*?)' + CLOSE + '\\s*parameter\\s*>',
    'gi'
  );
  let m;
  while ((m = paramRe.exec(body)) !== null) {
    const name = m[1];
    const attrs = m[2] || '';
    const value = m[3].replace(new RegExp(OPEN, 'g'), '').replace(new RegExp(CLOSE, 'g'), '').trim();

    if (/string\s*=\s*"true"/i.test(attrs)) {
      out[name] = value;
    } else {
      const parsed = tryJson(value);
      out[name] = parsed === undefined ? value : parsed;
    }
  }
  return out;
}

function tryJson(s) {
  const t = String(s || '').trim();
  if (!t) return undefined;
  if (!/^[[{"]|^-?\d|^(true|false|null)$/.test(t)) return undefined;
  try { return JSON.parse(t); } catch (e) { return undefined; }
}

/**
 * 删掉所有 DSML 标记与包裹的调用块，得到干净正文。
 * 纯调用（没有正文）会被清成空串，调用方据此决定是否继续流程。
 */
export function stripDsml(text) {
  if (!containsDsml(text)) return String(text || '');

  let s = normalize(text);

  // 1. 整块 calls / function_calls 包裹
  s = s.replace(
    new RegExp(OPEN + '\\s*(?:function_)?calls\\s*>[\\s\\S]*?' + CLOSE + '\\s*(?:function_)?calls\\s*>', 'gi'),
    ''
  );

  // 2. 残留的 invoke 块（没有外层包裹时）
  s = s.replace(
    new RegExp(OPEN + '\\s*invoke\\s+name\\s*=\\s*"[^"]+"\\s*>[\\s\\S]*?' + CLOSE + '\\s*invoke\\s*>', 'gi'),
    ''
  );

  // 3. 单个参数块
  s = s.replace(
    new RegExp(OPEN + '\\s*parameter[^>]*>[\\s\\S]*?' + CLOSE + '\\s*parameter\\s*>', 'gi'),
    ''
  );

  // 4. 标记被删掉后裸露的标签名（残缺的 calls> / invoke ...> / parameter ...>）
  //    注意：这里不能要求有 '<'，因为标记吃掉后剩下的就是裸的 "calls>"
  s = s.replace(/<?\s*\/?\s*(?:function_)?calls\s*>/gi, '');
  s = s.replace(/<?\s*\/?\s*invoke\b[^>]*>/gi, '');
  s = s.replace(/<?\s*\/?\s*parameter\b[^>]*>/gi, '');

  // 5. 最后清掉所有孤立标记
  s = s.split(OPEN).join('');
  s = s.split(CLOSE).join('');

  // 6. 收拾空行
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
