#!/usr/bin/env node
/**
 * 一键跑全部测试。
 *   node tests/run.mjs
 *
 * 会自动定位 jsdom（页面提取测试需要），找不到时可以用 PC_NODE_MODULES 指定。
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const NODE_DIR = path.dirname(process.execPath);

const candidates = [
  process.env.PC_NODE_MODULES,
  path.resolve(NODE_DIR, '..', '..', 'workspace', 'node_modules'),
  path.resolve(NODE_DIR, '..', '..', '..', 'workspace', 'node_modules'),
  path.resolve(ROOT, 'node_modules')
].filter(Boolean);

const modPath = candidates.find((dir) => {
  try {
    return fs.existsSync(path.join(dir, 'jsdom', 'package.json'));
  } catch (e) {
    return false;
  }
});

const env = Object.assign({}, process.env);
if (modPath) {
  env.NODE_PATH = modPath;
  console.log('[run] jsdom 位于 ' + modPath);
} else {
  console.warn('[run] 没找到 jsdom，页面提取相关测试会失败。');
  console.warn('[run] 用 PC_NODE_MODULES=<含 jsdom 的 node_modules> 指定。');
}

const cliArgs = process.argv.slice(2);
let testFiles;
if (cliArgs.length) {
  testFiles = cliArgs;
} else {
  // Node 的 --test 不认目录参数（会当成模块入口），这里自己列文件
  testFiles = fs.readdirSync(path.join(ROOT, 'tests'))
    .filter((f) => f.endsWith('.test.mjs'))
    .sort()
    .map((f) => path.join('tests', f));
}

if (testFiles.length === 0) {
  console.error('[run] tests/ 下没有找到 *.test.mjs');
  process.exit(1);
}

console.log('[run] 共 ' + testFiles.length + ' 个测试文件');
const args = ['--test'].concat(testFiles);
const result = spawnSync(process.execPath, args, {
  cwd: ROOT,
  env,
  stdio: 'inherit'
});

process.exit(result.status === null ? 1 : result.status);
