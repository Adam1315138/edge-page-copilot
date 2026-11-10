/**
 * 工具循环在「模型把调用写成 DSML 文本」时的行为验证。
 * 这是用户实际踩到的场景：正文里出现 <|||DSML|||>invoke ...>，工具却没被执行。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runToolLoop } from '../src/lib/agent.js';

const DSML_CONTENT = [
  '<|||DSML|||>calls>',
  '<|||DSML|||>invoke name="read_url">',
  '<|||DSML|||>parameter name="url" string="true">https://example.com/a</|||DSML|||>parameter>',
  '</|||DSML|||>invoke>',
  '<|||DSML|||>invoke name="web_search">',
  '<|||DSML|||>parameter name="query" string="true">测试查询</|||DSML|||>parameter>',
  '</|||DSML|||>invoke>',
  '</|||DSML|||>calls>'
].join('\n');

test('DSML 文本调用会被解析、执行，并从正文清除', async () => {
  const messages = [{ role: 'user', content: '帮我查一下' }];
  const tools = [{ type: 'function', function: { name: 'read_url' } }];
  const executed = [];
  const notices = [];
  let round = 0;

  const result = await runToolLoop({
    messages,
    tools,
    maxRounds: 3,
    onNotice: (t) => notices.push(t),
    executeTool: async (call) => {
      executed.push({ name: call.function.name, args: call.function.arguments });
      return '工具结果：示例正文';
    },
    callModel: async () => {
      round += 1;
      if (round === 1) {
        // 关键：只给 content，不给结构化 toolCalls
        return { content: DSML_CONTENT, toolCalls: [], finishReason: 'stop', usage: null };
      }
      return { content: '根据检索结果，答案是 42。', toolCalls: [], finishReason: 'stop', usage: null };
    }
  });

  // 两个工具都执行了
  assert.equal(executed.length, 2);
  assert.equal(executed[0].name, 'read_url');
  assert.deepEqual(JSON.parse(executed[0].args), { url: 'https://example.com/a' });
  assert.equal(executed[1].name, 'web_search');
  assert.deepEqual(JSON.parse(executed[1].args), { query: '测试查询' });

  // 最终正文干净、且是第二轮的内容
  assert.equal(result.content, '根据检索结果，答案是 42。');
  assert.ok(!result.content.includes('DSML'));
  assert.equal(result.toolRounds, 1);

  // 有提示，且回填的是 user 消息（不走 tool 协议，避免被中转拒）
  assert.ok(notices.some((n) => n.includes('已自动解析')));
  const backfill = messages.find((m) => m.role === 'user' && m.content.includes('工具返回的结果'));
  assert.ok(backfill, '应把工具结果作为用户补充材料回填');
  assert.ok(backfill.content.includes('示例正文'));
});

test('结构化 tool_calls 仍然按原协议走', async () => {
  const messages = [{ role: 'user', content: '查一下' }];
  const executed = [];
  let round = 0;

  const result = await runToolLoop({
    messages,
    tools: [{ type: 'function', function: { name: 'web_search' } }],
    maxRounds: 3,
    executeTool: async (call) => { executed.push(call.name || call.id); return 'ok'; },
    callModel: async () => {
      round += 1;
      if (round === 1) {
        return {
          content: '',
          toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"query":"x"}' } }],
          finishReason: 'tool_calls'
        };
      }
      return { content: '答完了', toolCalls: [], finishReason: 'stop' };
    }
  });

  assert.equal(executed.length, 1);
  assert.equal(result.content, '答完了');
  const toolMsg = messages.find((m) => m.role === 'tool');
  assert.ok(toolMsg, '结构化调用应回填 tool 消息');
  assert.equal(toolMsg.tool_call_id, 'call_1');
});

test('普通回答不受影响', async () => {
  const result = await runToolLoop({
    messages: [{ role: 'user', content: '你好' }],
    tools: [],
    executeTool: async () => 'x',
    callModel: async () => ({ content: '你好，有什么可以帮你？', toolCalls: [], finishReason: 'stop' })
  });
  assert.equal(result.content, '你好，有什么可以帮你？');
  assert.equal(result.toolRounds, 0);
});
