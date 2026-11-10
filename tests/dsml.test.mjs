/**
 * DSML 解析与清理的单元测试。
 * 样本直接取自用户截图里实际漏出来的那段文本。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { containsDsml, extractDsmlCalls, stripDsml } from '../src/lib/dsml.js';

// 截图里真实出现的形态：管道符会被渲染成带空格的 < | | | DSML | | |
const SAMPLE = [
  '<|||DSML|||>calls>',
  '<|||DSML|||>invoke name="read_url">',
  '<|||DSML|||>parameter name="url" string="true">https://link.springer.com/article/10.1186/s12966-017-0504-0</|||DSML|||>parameter>',
  '</|||DSML|||>invoke>',
  '<|||DSML|||>invoke name="web_search">',
  '<|||DSML|||>parameter name="query" string="true">"Review of Reviews" MVPA in physical education 2023 Hollis</|||DSML|||>parameter>',
  '</|||DSML|||>invoke>',
  '</|||DSML|||>calls>'
].join('\n');

test('能识别 DSML 标记（含多管道与空格变体）', () => {
  assert.equal(containsDsml(SAMPLE), true);
  assert.equal(containsDsml('<|DSML|>invoke name="x">'), true);
  assert.equal(containsDsml('< | | | DSML | | | calls>'), true);
  assert.equal(containsDsml('普通回答，没有标记'), false);
  assert.equal(containsDsml(''), false);
  assert.equal(containsDsml(null), false);
});

test('能把 DSML 还原成工具调用', () => {
  const calls = extractDsmlCalls(SAMPLE);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].function.name, 'read_url');
  assert.deepEqual(JSON.parse(calls[0].function.arguments), {
    url: 'https://link.springer.com/article/10.1186/s12966-017-0504-0'
  });
  assert.equal(calls[1].function.name, 'web_search');
  assert.deepEqual(JSON.parse(calls[1].function.arguments), {
    query: '"Review of Reviews" MVPA in physical education 2023 Hollis'
  });
  // id 必须唯一，否则回填 tool 消息时会串
  assert.notEqual(calls[0].id, calls[1].id);
});

test('非字符串参数会按 JSON 解析', () => {
  const src = [
    '<|DSML|>invoke name="web_search">',
    '<|DSML|>parameter name="query" string="true">测试</|DSML|>parameter>',
    '<|DSML|>parameter name="limit">5</|DSML|>parameter>',
    '</|DSML|>invoke>'
  ].join('\n');
  const [call] = extractDsmlCalls(src);
  const args = JSON.parse(call.function.arguments);
  assert.equal(args.query, '测试');
  assert.equal(args.limit, 5);
});

test('清理后正文里不留任何标记', () => {
  const dirty = '先说一句。\n\n' + SAMPLE + '\n\n然后是结论。';
  const clean = stripDsml(dirty);
  assert.equal(containsDsml(clean), false);
  assert.ok(!clean.includes('invoke'));
  assert.ok(!clean.includes('parameter'));
  assert.ok(clean.includes('先说一句'));
  assert.ok(clean.includes('然后是结论'));
});

test('纯调用（没有正文）清理后为空串', () => {
  assert.equal(stripDsml(SAMPLE), '');
});

test('普通文本原样返回', () => {
  const normal = '这是一段正常回答，包含 [1] 引用和 code 片段。';
  assert.equal(stripDsml(normal), normal);
});

test('没有 invoke 的残缺调用不会抛错', () => {
  assert.deepEqual(extractDsmlCalls('<|||DSML|||>calls>\n随便写点'), []);
  assert.equal(stripDsml('<|||DSML|||>calls>\n随便写点'), '随便写点');
});
