/**
 * 智能体工具循环。
 *
 * 抽成纯函数的好处：可以注入假的 callModel / executeTool 来验证多轮工具调用，
 * 不必启动浏览器或联网。
 */

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
    content = (res && res.content) || '';

    const calls = Array.isArray(res && res.toolCalls) ? res.toolCalls : [];
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
