/**
 * 工具循环逻辑测试（纯逻辑，注入假模型，不联网）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { runToolLoop } from '../src/lib/agent.js';

function fakeCallModel(script) {
  let i = 0;
  const calls = [];
  const fn = async ({ messages, tools }) => {
    calls.push({ messages: JSON.parse(JSON.stringify(messages)), tools });
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    return typeof step === 'function' ? step({ messages, tools }) : step;
  };
  fn.calls = calls;
  return fn;
}

test('模型不调用工具时直接返回正文', async () => {
  const messages = [{ role: 'user', content: '你好' }];
  const callModel = fakeCallModel([{ content: '你好，有什么可以帮你？', toolCalls: [], finishReason: 'stop', usage: { total_tokens: 9 } }]);
  const result = await runToolLoop({
    messages,
    tools: [],
    callModel,
    executeTool: async () => 'should-not-run'
  });

  assert.equal(result.content, '你好，有什么可以帮你？');
  assert.equal(result.toolRounds, 0);
  assert.equal(result.usage.total_tokens, 9);
  assert.equal(messages.length, 1, '没有工具调用时不应改动 messages');
});

test('一轮工具调用：执行工具后带上结果再请求一次', async () => {
  const messages = [{ role: 'user', content: '最近的新闻？' }];
  const executed = [];

  const callModel = fakeCallModel([
    {
      content: '',
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"query":"新闻"}' } }]
    },
    { content: '根据检索结果，最近发生了 X。', toolCalls: [], finishReason: 'stop' }
  ]);

  const result = await runToolLoop({
    messages,
    tools: [{ type: 'function', function: { name: 'web_search' } }],
    callModel,
    executeTool: async (call) => {
      executed.push(call.id);
      return '检索结果：X 发生了';
    }
  });

  assert.equal(executed.length, 1);
  assert.equal(executed[0], 'call_1');
  assert.equal(result.toolRounds, 1);
  assert.equal(result.content, '根据检索结果，最近发生了 X。');

  // 关键：第二次请求里必须出现符合 OpenAI/DeepSeek 规范的 assistant + tool 消息
  const secondRequest = callModel.calls[1].messages;
  assert.equal(secondRequest.length, 3);
  assert.equal(secondRequest[1].role, 'assistant');
  assert.equal(secondRequest[1].tool_calls[0].id, 'call_1');
  assert.equal(secondRequest[2].role, 'tool');
  assert.equal(secondRequest[2].tool_call_id, 'call_1');
  assert.equal(secondRequest[2].content, '检索结果：X 发生了');
});

test('工具抛错不会中断流程，错误信息回灌给模型', async () => {
  const messages = [{ role: 'user', content: 'q' }];
  const callModel = fakeCallModel([
    {
      content: '',
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'read_url', arguments: '{}' } }]
    },
    { content: '抱歉，抓取失败。', toolCalls: [], finishReason: 'stop' }
  ]);

  const result = await runToolLoop({
    messages,
    tools: [{ type: 'function', function: { name: 'read_url' } }],
    callModel,
    executeTool: async () => { throw new Error('网络不通'); }
  });

  assert.equal(result.content, '抱歉，抓取失败。');
  const toolMsg = callModel.calls[1].messages.find((m) => m.role === 'tool');
  assert.ok(toolMsg, '仍然要生成 tool 消息');
  assert.ok(toolMsg.content.includes('网络不通'), '错误信息要回灌, 实际: ' + toolMsg.content);
});

test('达到轮次上限后不再下发工具，避免无限循环', async () => {
  const messages = [{ role: 'user', content: 'q' }];
  let noticed = '';
  const callModel = fakeCallModel([
    {
      content: '',
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{"query":"a"}' } }]
    }
  ]);

  const result = await runToolLoop({
    messages,
    tools: [{ type: 'function', function: { name: 'web_search' } }],
    callModel,
    executeTool: async () => '结果',
    maxRounds: 2,
    onNotice: (t) => { noticed = t; }
  });

  // 2 轮工具执行 + 1 轮收尾
  assert.equal(result.toolRounds, 2);
  assert.ok(noticed.includes('上限'));
  // 最后一轮请求 tools 必须是空数组
  const last = callModel.calls[callModel.calls.length - 1];
  assert.equal(last.tools.length, 0, '收尾轮不应再下发工具');
});

test('多个工具并行结果都按顺序回灌', async () => {
  const messages = [{ role: 'user', content: 'q' }];
  const callModel = fakeCallModel([
    {
      content: '',
      finishReason: 'tool_calls',
      toolCalls: [
        { id: 'a', type: 'function', function: { name: 'web_search', arguments: '{"query":"1"}' } },
        { id: 'b', type: 'function', function: { name: 'read_url', arguments: '{"url":"https://x.com"}' } }
      ]
    },
    { content: 'done', toolCalls: [], finishReason: 'stop' }
  ]);

  const order = [];
  await runToolLoop({
    messages,
    tools: [{ type: 'function', function: { name: 'web_search' } }],
    callModel,
    executeTool: async (call) => { order.push(call.id); return 'r-' + call.id; }
  });

  assert.deepEqual(order, ['a', 'b']);
  const toolMsgs = callModel.calls[1].messages.filter((m) => m.role === 'tool');
  assert.equal(toolMsgs.length, 2);
  assert.equal(toolMsgs[0].tool_call_id, 'a');
  assert.equal(toolMsgs[1].tool_call_id, 'b');
});
