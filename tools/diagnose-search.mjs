/**
 * 诊断：Node fetch 与 curl 拿到的 Bing 结果为什么不同。
 *   node tools/diagnose-search.mjs
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';

async function probe(label, url, headers) {
  try {
    const res = await fetch(url, { headers });
    const html = await res.text();
    const bAlgo = (html.match(/class="b_algo"/g) || []).length;
    const ddgLink = (html.match(/class=['"]result-link['"]/g) || []).length;
    const looksChallenge = /captcha|unusual traffic|are you a robot|verify you are human/i.test(html);
    console.log('[' + label + '] status=' + res.status + ' bytes=' + html.length
      + ' b_algo=' + bAlgo + ' ddg=' + ddgLink + ' challenge=' + looksChallenge);
    console.log('   前 160 字符: ' + JSON.stringify(html.slice(0, 160)));
    return { bAlgo, ddgLink, looksChallenge, bytes: html.length };
  } catch (e) {
    console.log('[' + label + '] 失败: ' + e.message);
    return null;
  }
}

const bingUrl = 'https://www.bing.com/search?q=TypeScript+5+release+notes&setlang=zh-CN&form=QBLH';

console.log('=== Bing ===');
await probe('带 UA', bingUrl, { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' });
await new Promise((r) => setTimeout(r, 1200));
await probe('不带 UA（纯 Node 默认）', bingUrl, { Accept: 'text/html,application/xhtml+xml' });

console.log('\n=== DuckDuckGo lite ===');
await probe('带 UA', 'https://lite.duckduckgo.com/lite/?q=TypeScript', { 'User-Agent': UA });
await new Promise((r) => setTimeout(r, 1200));
await probe('不带 UA', 'https://lite.duckduckgo.com/lite/?q=TypeScript', {});
