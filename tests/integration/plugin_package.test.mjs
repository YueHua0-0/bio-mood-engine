import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';

const PLUGIN_ROOT = new URL('../../plugins/bio-mood-engine/', import.meta.url);

const ALLOWED_FILES = new Set([
  'README.md',
  'plugin.json',
  'index.mjs',
  'ui.json',
  'ui/page.html',
  'ui/page.js',
  'ui/style.css',
  'lib/adapter/wechatagent/degrade.mjs',
  'lib/adapter/wechatagent/events.mjs',
  'lib/adapter/wechatagent/hooks.mjs',
  'lib/adapter/wechatagent/manifest.mjs',
  'lib/adapter/wechatagent/repo.mjs',
  'lib/adapter/wechatagent/tools.mjs'
]);

const FORBIDDEN_DIRS = new Set(['node_modules', 'tests', 'docs', '.git']);
const BANNED_PATTERNS = [
  /process\.cwd/,
  /Math\.random/,
  /new Date\(/,
  /console\.log/,
  // P-13-17 起 manifest 需要识别 wxid 明文，这里只禁真实 wxid，不禁字段名。
  /wxid_[A-Za-z0-9_-]{4,}/i
];

function walk(dirUrl, prefix = '', depth = 1, out = []) {
  for (const entry of readdirSync(dirUrl, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dirUrl);
    const stat = lstatSync(url);
    out.push({ rel, url, depth, isDirectory: entry.isDirectory(), isSymbolicLink: stat.isSymbolicLink(), size: stat.size });
    if (entry.isDirectory()) walk(url, rel, depth + 1, out);
  }
  return out;
}

const entries = walk(PLUGIN_ROOT);
const files = entries.filter((entry) => !entry.isDirectory);

test('P15 打包清单：条目/体积/层级/禁用目录/链接均在限额内', () => {
  assert.ok(entries.length <= 128, `条目 ${entries.length}`);
  assert.ok(Math.max(...entries.map((entry) => entry.depth)) <= 8, '目录层级 ≤8');

  let total = 0;
  for (const file of files) {
    total += file.size;
    assert.ok(file.size <= 4 * 1024 * 1024, `${file.rel} 超过 4 MiB`);
    assert.equal(file.isSymbolicLink, false, `${file.rel} 不得是链接`);
  }
  assert.ok(total <= 16 * 1024 * 1024, `解压总体积 ${total}`);

  for (const entry of entries) {
    const segments = entry.rel.split('/');
    for (const segment of segments) {
      assert.equal(FORBIDDEN_DIRS.has(segment), false, `不得包含 ${segment}`);
    }
  }

  const names = new Set(files.map((file) => file.rel));
  assert.deepEqual([...names].sort(), [...ALLOWED_FILES].sort(), '包内只允许 §7 清单文件');
  assert.ok(!names.has('package.json'));
});

test('P16 静态检索：无 process.cwd / Math.random / new Date( / console.log / 明文账号', () => {
  const sources = files.filter((file) => file.rel.endsWith('.mjs'));
  assert.ok(sources.length >= 7);
  for (const file of sources) {
    const text = readFileSync(file.url, 'utf8');
    for (const pattern of BANNED_PATTERNS) {
      assert.doesNotMatch(text, pattern, `${file.rel} 命中 ${pattern}`);
    }
    for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      assert.doesNotMatch(match[1], /node_modules/, `${file.rel} 不得导入 node_modules`);
    }
  }
});
