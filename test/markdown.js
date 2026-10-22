'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

async function main() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const start = src.indexOf('function mdSafeHref');
  const end = src.indexOf('\nfunction renderProcessHistory');
  assert(start >= 0 && end > start, 'Markdown renderer not found in index.html');

  const markedFile = path.join(path.dirname(require.resolve('marked/package.json')), 'lib', 'marked.umd.js');
  const context = { console };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(markedFile, 'utf8'), context);
  assert(context.marked && context.marked.Marked, 'Marked browser bundle did not load');
  context.window = context;
  context.location = { href: 'http://localhost/' };
  context.URL = URL;
  context.esc = esc;
  vm.runInContext(src.slice(start, end) + '\nthis.renderMarkdown = renderMarkdown;', context);

  const html = context.renderMarkdown([
    '# 标题',
    '',
    '- 第一项',
    '- 第二项',
    '',
    '| 列 A | 列 B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '```js',
    'console.log(1);',
    '```',
    '',
    '[安全链接](https://example.com)',
    '[危险链接](javascript:alert(1))',
    '<img src=x onerror=alert(1)>',
  ].join('\n'));

  assert.match(html, /<h1>标题<\/h1>/);
  assert.match(html, /<ul>[\s\S]*<li>第一项<\/li>/);
  assert.match(html, /<table>[\s\S]*<th>列 A<\/th>/);
  assert.match(html, /class="code-wrap"[\s\S]*class="copy-btn"/);
  assert.match(html, /href="https:\/\/example\.com"[^>]*rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.doesNotMatch(html, /<img\b/i);
  console.log('Markdown renderer: PASS');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
