/**
 * 13 §5.8 / 15 §5.7：打包确定性与 ZIP 内容契约。
 *
 * 与 `release_manifest.test.mjs` 的 V15 分工：
 *   - V15：本地持有候选 ZIP 时，验证候选包与打包器输出逐字节一致（依赖 `release/`）。
 *   - 本文件：不依赖 `release/`，在 CI 中验证「两次打包同字节」与「包内容符合契约」。
 * 两者职责不同：确定性不等于正确性，因此内容契约必须独立断言。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { packPlugin } from '../../scripts/pack-plugin.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const PLUGIN_DIR = join(ROOT, 'plugins', 'bio-mood-engine');
const RUNTIME_LIB_DIRS = ['core', 'modules', 'storage'];

/** 13 §5.8：允许进包的目录/扩展名，以及文本扩展名。 */
const PACKAGE_ROOTS = new Set(['plugin.json', 'index.mjs', 'README.md', 'ui.json']);
const PACKAGE_PREFIXES = ['ui/', 'lib/'];
const SKIP_DIRS = new Set(['node_modules', 'tests', 'test', '__tests__', '.git', '.cache']);
const SKIP_EXT = new Set(['.map', '.log', '.snap', '.tmp']);
const TEXT_EXT = new Set(['.mjs', '.js', '.json', '.md', '.html', '.css']);

const DOS_TIME = 0;
const DOS_DATE = 0x0021;
const FLAG_UTF8 = 0x0800;

function compareName(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function walk(dir, base = dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(full, base, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (SKIP_EXT.has(extname(entry.name))) continue;
    out.push({ full, path: relative(base, full).split(sep).join('/') });
  }
  return out;
}

/** 按契约独立推导期望条目（不复用打包器的 `included()` / `listFiles()`）。 */
async function expectedFiles() {
  const pluginFiles = (await walk(PLUGIN_DIR)).filter(
    (file) =>
      PACKAGE_ROOTS.has(file.path) ||
      PACKAGE_PREFIXES.some((prefix) => file.path.startsWith(prefix))
  );
  const runtimeFiles = [];
  for (const dir of RUNTIME_LIB_DIRS) {
    for (const file of await walk(join(ROOT, 'lib', dir), join(ROOT, 'lib'))) {
      runtimeFiles.push({ full: file.full, path: `lib/${file.path}` });
    }
  }
  return [...pluginFiles, ...runtimeFiles].sort((a, b) => compareName(a.path, b.path));
}

/** 期望入包内容：与打包器同样的两处引用重写 + 文本换行归一化（LF）。 */
async function expectedContent(file) {
  let text = await readFile(file.full, 'utf8');
  if (file.path === 'index.mjs') {
    text = text.split("'../../lib/").join("'./lib/");
  } else if (file.path.startsWith('lib/adapter/')) {
    text = text.split("'../../../../../lib/").join("'../../../lib/");
  }
  if (TEXT_EXT.has(extname(file.path))) text = text.replace(/\r\n/g, '\n');
  return Buffer.from(text, 'utf8');
}

function parseZip(buf) {
  const entries = [];
  let offset = 0;
  while (offset + 30 <= buf.length && buf.readUInt32LE(offset) === 0x04034b50) {
    const csize = buf.readUInt32LE(offset + 18);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const name = buf.subarray(offset + 30, offset + 30 + nameLen).toString('utf8');
    const dataStart = offset + 30 + nameLen + extraLen;
    const method = buf.readUInt16LE(offset + 8);
    const raw = buf.subarray(dataStart, dataStart + csize);
    entries.push({
      name,
      version: buf.readUInt16LE(offset + 4),
      flag: buf.readUInt16LE(offset + 6),
      method,
      dosTime: buf.readUInt16LE(offset + 10),
      dosDate: buf.readUInt16LE(offset + 12),
      crc: buf.readUInt32LE(offset + 14),
      csize,
      usize: buf.readUInt32LE(offset + 22),
      extraLen,
      data: method === 8 ? inflateRawSync(raw) : Buffer.from(raw)
    });
    offset = dataStart + csize;
  }

  const central = [];
  let cursor = offset;
  while (cursor + 46 <= buf.length && buf.readUInt32LE(cursor) === 0x02014b50) {
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    central.push({
      name: buf.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8'),
      extraLen,
      commentLen,
      extAttr: buf.readUInt32LE(cursor + 38)
    });
    cursor += 46 + nameLen + extraLen + commentLen;
  }

  return {
    entries,
    central,
    eocd: {
      count: buf.readUInt16LE(buf.length - 12),
      centralSize: buf.readUInt32LE(buf.length - 10),
      centralOffset: buf.readUInt32LE(buf.length - 6)
    }
  };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

test('打包确定性：同一输入连续两次产出相同字节（CI 可执行）', async () => {
  const first = await packPlugin();
  const second = await packPlugin();

  assert.ok(first.zip.length > 0, '打包结果不得为空');
  assert.ok(
    first.zip.equals(second.zip),
    `两次打包字节不同：${first.zip.length} vs ${second.zip.length}`
  );
  assert.deepEqual(first.manifest.files, second.manifest.files);
  assert.equal(first.manifest.zip_bytes, first.zip.length);
  assert.equal(first.manifest.unpacked_bytes, second.manifest.unpacked_bytes);
});

test('ZIP 内容契约：条目集合、顺序、内容与必要元数据', async () => {
  const { zip, manifest } = await packPlugin();
  const parsed = parseZip(zip);
  const expected = await expectedFiles();

  assert.equal(parsed.entries.length, expected.length, '条目数量与契约不一致');
  assert.deepEqual(
    parsed.entries.map((entry) => entry.name),
    expected.map((file) => file.path),
    '条目集合或顺序与契约不一致（应按名升序、无缺漏、无多余）'
  );

  for (let i = 1; i < parsed.entries.length; i += 1) {
    assert.ok(
      compareName(parsed.entries[i - 1].name, parsed.entries[i].name) < 0,
      `条目顺序未严格升序：${parsed.entries[i - 1].name} → ${parsed.entries[i].name}`
    );
  }

  for (let i = 0; i < parsed.entries.length; i += 1) {
    const entry = parsed.entries[i];
    const file = expected[i];
    const label = entry.name;

    assert.equal(entry.version, 20, `${label} 解压所需版本应为 20`);
    assert.equal(entry.flag, FLAG_UTF8, `${label} 通用标志应为 UTF-8（0x0800）`);
    assert.equal(entry.method, 8, `${label} 压缩方法应为 deflate`);
    assert.equal(entry.dosTime, DOS_TIME, `${label} 时间戳必须固定，否则产物不可复现`);
    assert.equal(entry.dosDate, DOS_DATE, `${label} 日期必须固定，否则产物不可复现`);
    assert.equal(entry.extraLen, 0, `${label} 不得携带额外字段`);
    assert.equal(entry.usize, entry.data.length, `${label} 长度字段与实际内容不符`);
    assert.equal(entry.crc, crc32(entry.data), `${label} CRC32 校验失败`);
    assert.ok(
      entry.data.equals(await expectedContent(file)),
      `${label} 内容与源码（含引用重写与换行归一化）不一致`
    );
    if (TEXT_EXT.has(extname(label))) {
      assert.ok(!entry.data.includes(Buffer.from('\r\n')), `${label} 文本条目内仍有 CRLF`);
    }
  }

  assert.equal(parsed.central.length, parsed.entries.length, '中央目录条目数不一致');
  for (const item of parsed.central) {
    assert.equal(item.extraLen, 0, `${item.name} 中央目录不得携带额外字段`);
    assert.equal(item.commentLen, 0, `${item.name} 不得携带注释`);
    assert.equal(item.extAttr, 0, `${item.name} 不得写入平台相关的文件属性`);
  }
  assert.equal(parsed.eocd.count, parsed.entries.length, 'EOCD 条目数不一致');
  assert.equal(parsed.eocd.centralSize + parsed.eocd.centralOffset, zip.length - 22, 'EOCD 偏移与包体不符');

  assert.deepEqual(
    manifest.files,
    parsed.entries.map((entry) => ({ path: entry.name, bytes: entry.data.length })),
    'manifest.files 与实际条目不一致'
  );
});

test('换行等价：LF 与 CRLF 源打包出相同字节', async () => {
  const base = await mkdtemp(join(tmpdir(), 'bio-mood-pack-eol-'));
  const lfDir = join(base, 'lf');
  const crlfDir = join(base, 'crlf');
  try {
    await cp(PLUGIN_DIR, lfDir, { recursive: true });
    await cp(lfDir, crlfDir, { recursive: true });

    let converted = 0;
    for (const file of await walk(crlfDir)) {
      if (!TEXT_EXT.has(extname(file.path))) continue;
      const text = await readFile(file.full, 'utf8');
      const crlf = text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
      if (crlf !== text) converted += 1;
      await writeFile(file.full, crlf, 'utf8');
    }
    assert.ok(converted > 0, 'CRLF 夹具未生效：没有文本文件被转换');

    const lf = await packPlugin({ source: lfDir });
    const crlf = await packPlugin({ source: crlfDir });

    assert.equal(lf.zip.length, crlf.zip.length, 'LF 与 CRLF 源产出的包体积不同');
    assert.ok(lf.zip.equals(crlf.zip), 'LF 与 CRLF 源产出的包字节不同');

    for (const entry of parseZip(crlf.zip).entries) {
      assert.ok(!entry.data.includes(Buffer.from('\r\n')), `${entry.name} 仍带 CRLF`);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
