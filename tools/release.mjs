/**
 * 建 GitHub Release 的小工具。
 *
 *   GH_TOKEN=xxx node tools/release.mjs <tag> <标题> [notes.md]
 *
 * token 从环境变量读，不落盘、不打印。
 * 用凭据管理器里的 token：
 *   CRED=$(printf "protocol=https\nhost=github.com\n\n" | git credential fill)
 *   export GH_TOKEN=$(printf "%s" "$CRED" | sed -n 's/^password=//p')
 */

import fs from 'node:fs';
import path from 'node:path';

const OWNER = 'Adam1315138';
const REPO = 'edge-page-copilot';

const [tag, title, notesPath] = process.argv.slice(2);
const token = process.env.GH_TOKEN;

if (!token) {
  console.error('缺少 GH_TOKEN 环境变量');
  process.exit(1);
}
if (!tag) {
  console.error('用法: GH_TOKEN=xxx node tools/release.mjs <tag> [标题] [notes.md]');
  process.exit(1);
}

let body = '';
if (notesPath && fs.existsSync(notesPath)) {
  body = fs.readFileSync(notesPath, 'utf8');
}

const payload = {
  tag_name: tag,
  name: title || tag,
  body,
  draft: false,
  prerelease: false
};

const res = await fetch('https://api.github.com/repos/' + OWNER + '/' + REPO + '/releases', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'edge-page-copilot-release-script'
  },
  body: JSON.stringify(payload)
});

const text = await res.text();

if (!res.ok) {
  console.error('建 Release 失败 HTTP ' + res.status);
  try {
    const j = JSON.parse(text);
    console.error('原因: ' + (j.message || '') + (j.errors ? ' ' + JSON.stringify(j.errors) : ''));
  } catch (e) {
    console.error(text.slice(0, 400));
  }
  process.exit(1);
}

const data = JSON.parse(text);
console.log('Release 已创建');
console.log('  标签: ' + data.tag_name);
console.log('  标题: ' + data.name);
console.log('  页面: ' + data.html_url);
console.log('  下载: ' + data.zipball_url + '  (源码 zip)');
