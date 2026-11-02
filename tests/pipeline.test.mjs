/**
 * 端到端链路测试：本地起一个假 DeepSeek 服务，走真实 HTTP + SSE。
 * 覆盖：流式拼接 / tool_calls 分片 / usage / 错误码 / 中断 / reasoning。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { streamChat } from '../src/lib/openai.js';
import { runToolLoop } from '../src/lib/agent.js';
import { mergeSettings } from '../src/lib/util.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sse(obj) {
  return 'data: ' + JSON.stringify(obj) + '\n\n';
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

/** 启动 mock 服务；onRequest 拿到解析后的请求体，自行决定怎么回 */
async function startServer(onRequest) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const raw = await readBody(req);
    let body = null;
    try { body = JSON.parse(raw); } catch (e) { body = null; }
    requests.push({ url: req.url, headers: req.headers, body, raw });
    try {
      await onRequest(req, res, body, requests.length);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('mock error: ' + err.message);
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: 'http://127.0.0.1:' + port + '/v1',
    requests,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    })
  };
}

function makeSettings(baseUrl, extra = {}) {
  return mergeSettings(Object.assign({
    apiKey: 'sk-test-123',
    baseUrl,
    model: 'deepseek-chat'
  }, extra));
}

/* ------------------------------------------------------------------ */

test('流式文本逐块拼接，usage 与 finish_reason 正确收尾', async () => {
  const srv = await startServer(async (req, res, body) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const parts = ['你', '好', '，', '世界'];
    for (const p of parts) {
      res.write(sse({ choices: [{ delta: { content: p } }] }));
      await sleep(3);
    }
    res.write(sse({
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }
    }));
    res.write('data: [DONE]\n\n');
    res.end();
  });

  try {
    const deltas = [];
    const result = await streamChat({
      settings: makeSettings(srv.baseUrl),
      messages: [{ role: 'user', content: 'hi' }],
      onDelta: (t) => deltas.push(t)
    });

    assert.equal(result.content, '你好，世界');
    assert.deepEqual(deltas, ['你', '好', '，', '世界'], '增量回调应逐块到达');
    assert.equal(result.finishReason, 'stop');
    assert.equal(result.usage.total_tokens, 16);

    // 请求报文检查
    const req = srv.requests[0];
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer sk-test-123');
    assert.equal(req.body.model, 'deepseek-chat');
    assert.equal(req.body.stream, true);
    assert.deepEqual(req.body.stream_options, { include_usage: true });
  } finally {
    await srv.close();
  }
});

test('tool_calls 分片能跨 chunk 组装成合法参数', async () => {
  const srv = await startServer(async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_x', type: 'function', function: { name: 'web_search', arguments: '' } }] } }] }));
    await sleep(2);
    res.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"que' } }] } }] }));
    await sleep(2);
    res.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"SSE 原理"}' } }] } }] }));
    res.write(sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }));
    res.end();
  });

  try {
    const result = await streamChat({
      settings: makeSettings(srv.baseUrl),
      messages: [{ role: 'user', content: 'q' }],
      tools: [{ type: 'function', function: { name: 'web_search' } }]
    });

    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].id, 'call_x');
    assert.equal(result.toolCalls[0].function.name, 'web_search');
    assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), { query: 'SSE 原理' });
    assert.equal(result.finishReason, 'tool_calls');
    assert.equal(srv.requests[0].body.tools.length, 1);
    assert.equal(srv.requests[0].body.tool_choice, 'auto');
  } finally {
    await srv.close();
  }
});

test('完整链路：模型调工具 → 本地执行 → 二次请求 → 输出答案', async () => {
  const srv = await startServer(async (req, res, body, count) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (count === 1) {
      res.write(sse({ choices: [{ delta: { content: '我查一下。' } }] }));
      res.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"query":"DeepSeek 价格"}' } }] } }] }));
      res.write(sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }));
    } else {
      res.write(sse({ choices: [{ delta: { content: '根据 [1]，价格是 X。' } }] }));
      res.write(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
    }
    res.end();
  });

  try {
    const settings = makeSettings(srv.baseUrl);
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'DeepSeek 多少钱？' }
    ];
    const executed = [];

    const result = await runToolLoop({
      messages,
      tools: [{ type: 'function', function: { name: 'web_search' } }],
      callModel: ({ messages: m, tools }) => streamChat({ settings, messages: m, tools }),
      executeTool: async (call) => {
        const args = JSON.parse(call.function.arguments);
        executed.push(args.query);
        return '[1] DeepSeek 定价\nURL: https://example.com\n摘要: 价格是 X';
      }
    });

    assert.equal(executed[0], 'DeepSeek 价格');
    assert.equal(result.content, '根据 [1]，价格是 X。');
    assert.equal(result.toolRounds, 1);

    // 第二次请求体的结构必须符合 DeepSeek 工具回传规范
    const second = srv.requests[1].body.messages;
    assert.equal(second.length, 4);
    assert.equal(second[2].role, 'assistant');
    assert.equal(second[2].content, '我查一下。');
    assert.equal(second[2].tool_calls[0].id, 'call_1');
    assert.equal(second[3].role, 'tool');
    assert.equal(second[3].tool_call_id, 'call_1');
    assert.ok(second[3].content.includes('价格是 X'));
  } finally {
    await srv.close();
  }
});

test('HTTP 错误码转成可读中文，402 能识别为余额不足', async () => {
  const srv = await startServer(async (req, res) => {
    res.writeHead(402, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Insufficient Balance', type: 'insufficient_balance' } }));
  });

  try {
    await assert.rejects(
      () => streamChat({ settings: makeSettings(srv.baseUrl), messages: [{ role: 'user', content: 'hi' }] }),
      (err) => {
        assert.ok(err.message.includes('余额不足'), '实际: ' + err.message);
        assert.ok(err.message.includes('Insufficient Balance'), '应带上服务端原文');
        assert.ok(err.message.includes('402'));
        return true;
      }
    );
  } finally {
    await srv.close();
  }
});

test('401 提示 API Key 无效', async () => {
  const srv = await startServer(async (req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Authentication Fails' } }));
  });

  try {
    await assert.rejects(
      () => streamChat({ settings: makeSettings(srv.baseUrl), messages: [] }),
      (err) => {
        assert.ok(err.message.includes('API Key 无效'), '实际: ' + err.message);
        return true;
      }
    );
  } finally {
    await srv.close();
  }
});

test('中断请求会抛 AbortError', async () => {
  const srv = await startServer(async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(sse({ choices: [{ delta: { content: '开始' } }] }));
    // 故意挂着不结束
    await sleep(3000);
    res.end();
  });

  const controller = new AbortController();
  try {
    const promise = streamChat({
      settings: makeSettings(srv.baseUrl),
      messages: [],
      signal: controller.signal
    });
    setTimeout(() => controller.abort(), 60);
    await assert.rejects(promise, (err) => err.name === 'AbortError');
  } finally {
    await srv.close();
  }
});

test('deepseek-reasoner 的 reasoning_content 会被单独收集', async () => {
  const srv = await startServer(async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(sse({ choices: [{ delta: { reasoning_content: '先想一下' } }] }));
    res.write(sse({ choices: [{ delta: { reasoning_content: '，再算' } }] }));
    res.write(sse({ choices: [{ delta: { content: '答案是 42' } }] }));
    res.write(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
    res.end();
  });

  try {
    const reasonings = [];
    const result = await streamChat({
      settings: makeSettings(srv.baseUrl, { model: 'deepseek-reasoner' }),
      messages: [],
      onReasoning: (t) => reasonings.push(t)
    });
    assert.equal(result.reasoning, '先想一下，再算');
    assert.equal(result.content, '答案是 42');
    assert.deepEqual(reasonings, ['先想一下', '，再算']);
  } finally {
    await srv.close();
  }
});

test('流中返回 error 事件时抛出而不是静默吞掉', async () => {
  const srv = await startServer(async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(sse({ choices: [{ delta: { content: '部分' } }] }));
    res.write(sse({ error: { message: '流式处理失败' } }));
    res.end();
  });

  try {
    await assert.rejects(
      () => streamChat({ settings: makeSettings(srv.baseUrl), messages: [] }),
      (err) => {
        assert.ok(err.message.includes('流式处理失败'));
        return true;
      }
    );
  } finally {
    await srv.close();
  }
});
