/**
 * OpenAI 兼容接口客户端（DeepSeek / OpenAI / vLLM / Ollama 通用）。
 * 独立成模块以便在 Node 中直接对 mock 服务做测试。
 */

import {
  createSSEParser,
  createToolCallAccumulator,
  safeJsonParse,
  normalizeBaseUrl,
  buildChatRequestBody,
  truncate
} from './util.js';

export function describeHttpError(status, bodyText) {
  const json = safeJsonParse(bodyText);
  const detail = json && json.error && json.error.message
    ? json.error.message
    : truncate(String(bodyText || '').trim(), 300);
  const map = {
    400: '请求格式有误',
    401: 'API Key 无效或已失效',
    402: '账户余额不足',
    403: '没有该模型的访问权限',
    404: '接口地址或模型名不对（检查 Base URL 是否该以 /v1 结尾）',
    422: '请求参数不合法',
    429: '请求太频繁，被限流了',
    500: '服务端故障',
    503: '服务繁忙，稍后再试'
  };
  const prefix = map[status] ? map[status] + '：' : '请求失败：';
  return prefix + detail + '（HTTP ' + status + '）';
}

/**
 * 发起一次流式对话并聚合结果。
 *
 * @param {object}   p
 * @param {object}   p.settings      需要 baseUrl / apiKey / model / temperature
 * @param {Array}    p.messages
 * @param {Array}    [p.tools]
 * @param {AbortSignal} [p.signal]
 * @param {Function} [p.onDelta]     增量正文
 * @param {Function} [p.onReasoning] 增量思考（deepseek-reasoner 才有）
 * @param {Function} [p.onUsage]     用量
 * @param {Function} [p.fetchImpl]   便于测试注入
 * @returns {Promise<{content:string, reasoning:string, toolCalls:Array, finishReason:string, usage:object|null}>}
 */
export async function streamChat({
  settings,
  messages,
  tools,
  signal,
  onDelta,
  onReasoning,
  onUsage,
  fetchImpl
}) {
  const doFetch = fetchImpl || fetch;
  const url = normalizeBaseUrl(settings.baseUrl) + '/chat/completions';
  const body = buildChatRequestBody(settings, messages, { tools });
  if (settings.streamUsage) {
    body.stream_options = { include_usage: true };
  }

  const res = await doFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + settings.apiKey
    },
    body: JSON.stringify(body),
    signal
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(describeHttpError(res.status, text));
  }
  if (!res.body) {
    throw new Error('服务端没有返回流式响应体');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const acc = createToolCallAccumulator();

  let content = '';
  let reasoning = '';
  let finishReason = '';
  let usage = null;
  let streamError = null;
  let dsmlSeen = false;

  const parser = createSSEParser(({ data }) => {
    if (!data || data === '[DONE]') return;
    const json = safeJsonParse(data);
    if (!json) return;

    if (json.usage) {
      usage = json.usage;
      if (onUsage) onUsage(usage);
    }
    if (json.error) {
      streamError = new Error(json.error.message || '流式响应中返回了错误');
      return;
    }

    const choice = json.choices && json.choices[0];
    if (!choice) return;

    const delta = choice.delta || {};
    if (delta.reasoning_content) {
      reasoning += delta.reasoning_content;
      if (onReasoning) onReasoning(delta.reasoning_content);
    }
    if (delta.content) {
      content += delta.content;
      // 一旦正文里出现 DSML 调用标记，就停止往界面推流：
      // 这段标记不该给用户看，交给 agent.js 解析成工具调用、最后统一渲染干净正文。
      if (!dsmlSeen && content.includes('DSML')) dsmlSeen = true;
      if (onDelta && !dsmlSeen) onDelta(delta.content);
    }
    if (delta.tool_calls) acc.add(delta.tool_calls);
    if (choice.finish_reason) finishReason = choice.finish_reason;
  });

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.push(decoder.decode(value, { stream: true }));
  }
  parser.push(decoder.decode());
  parser.flush();

  if (streamError) throw streamError;

  return { content, reasoning, toolCalls: acc.list(), finishReason, usage };
}
