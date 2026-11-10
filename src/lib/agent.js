/**
 * 智能体工具循环。
 *
 * 抽成纯函数的好处：可以注入假的 callModel / executeTool 来验证多轮工具调用，
 * 不必启动浏览器或联网。
 *
 * 额外处理一种现实情况：某些中转地址或模型版本会把工具调用写进 content
 * （DeepSeek 的 <|DSML|> 标记），而不是走结构化 tool_calls。
 * 这里把它捞回来当工具调用执行，正文里的标记一律清掉。
 */
import { containsDsml, extractDsmlCalls, stripDsml } from './dsml.js';

/**
 * @param {object} p
 * @param {Array}  p.messages       会被原地追加 assistant / tool 消息
 * @param {Array}  p.tools          工具定义，空数组表示不允许调用
 * @param {Function} p.callModel    async ({messages, tools}) => {content, toolCalls, finishReason, usage}
 * @param {Function} p.executeTool  async (toolCall) => string
 * @param {number} [p.maxRounds]    最多几轮工具调用（默认 3）
 * @param {Function} [p.onNotice]   提示回调
 * @returns {Promise<{content:string, usage:object|null, toolRounds:number}>}
 */
export async function runToolLoop({
  messages,
  tools,
  callModel,
  executeTool,
  maxRounds = 3,
  onNotice
}) {
  const toolList = Array.isArray(tools) ? tools : [];
  let content = '';
  let usage = null;
  let toolRounds = 0;
  let guard = 0;

  while (true) {
    guard += 1;
    if (guard > maxRounds + 3) {
      // 理论上到不了这里，纯粹防止实现出错时死循环
      break;
    }

    // 轮次用尽后不再下发工具，逼模型直接作答
    const useTools = toolRounds < maxRounds ? toolList : [];
    if (toolRounds === maxRounds && toolList.length > 0 && onNotice) {
      onNotice('工具调用轮次已达上限，改用现有信息作答');
    }

    const res = await callModel({ messages, tools: useTools });
    if (res && res.usage) usage = res.usage;

    const rawContent = (res && res.content) || '';
    let calls = Array.isArray(res && res.toolCalls) ? res.toolCalls : [];
    let fromDsml = false;

    // 结构化没给调用，但正文里出现了 DSML 标记 → 还原成调用
    if (calls.length === 0 && useTools.length > 0 && containsDsml(rawContent)) {
      const parsed = extractDsmlCalls(rawContent);
      if (parsed.length > 0) {
        calls = parsed;
        fromDsml = true;
        if (onNotice) onNotice('模型把工具调用写成了文本，已自动解析并执行');
      }
    }

    // 正文一律清掉标记，别让用户看见
    content = stripDsml(rawContent);

    const finishReason = (res && res.finishReason) || '';
    // 不同兼容实现给出的 finish_reason 不完全一致（tool_calls / stop / 空），
    // 只要模型确实要了工具就执行；被截断或内容被过滤时除外。
    const wantsTools = calls.length > 0
      && finishReason !== 'length'
      && finishReason !== 'content_filter';

    if (!wantsTools) break;
    if (toolRounds >= maxRounds) {
      // 已经把工具收回去了还返回工具调用，只能就此收尾
      break;
    }

    if (fromDsml) {
      // 这种调用没走过正式的 tool_calls 协议，直接回填 tool 消息容易被服务端拒；
      // 改成把结果当"用户补充材料"喂回去，任何兼容实现都认。
      const parts = [];
      for (const call of calls) {
        let resultText;
        try {
          resultText = await executeTool(call);
        } catch (err) {
          resultText = '工具执行出错：' + (err && err.message ? err.message : String(err));
        }
        if (typeof resultText !== 'string') resultText = String(resultText == null ? '' : resultText);
        parts.push('【' + (call.function && call.function.name ? call.function.name : '工具') + '】\n' + resultText);
      }

      messages.push({ role: 'assistant', content: content || '（正在检索）' });
      messages.push({
        role: 'user',
        content: '以下是工具返回的结果，请基于它们直接回答用户的问题。\n'
          + '不要再输出任何调用标记（如 <|DSML|>），也不要重复工具名。\n\n'
          + parts.join('\n\n')
      });
      toolRounds += 1;
      continue;
    }

    messages.push({
      role: 'assistant',
      content: content || '',
      tool_calls: calls
    });

    for (const call of calls) {
      let resultText;
      try {
        resultText = await executeTool(call);
      } catch (err) {
        resultText = '工具执行出错：' + (err && err.message ? err.message : String(err));
      }
      if (typeof resultText !== 'string') resultText = String(resultText == null ? '' : resultText);
      messages.push({
        role: 'tool',
        tool_call_id: (call && call.id) || '',
        content: resultText
      });
    }

    toolRounds += 1;
  }

  return { content, usage, toolRounds };
}
