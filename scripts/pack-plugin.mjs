#!/usr/bin/env node
/**
 * 13 §5.8 / 15 §9：插件打包脚本（零第三方依赖，Node 内置 zlib 手写 ZIP）。
 *
 * 用法：
 *   node scripts/pack-plugin.mjs --out release/bio-mood-engine-0.1.0.zip
 *   node scripts/pack-plugin.mjs --out release/bio-mood-engine-0.0.9.zip --version 0.0.9
 *
 * 约束（超出即失败，不产出半成品）：
 *   - 包体积 ≤ 8 MiB，解压后 ≤ 16 MiB，单文件 ≤ 4 MiB；
 *   - 只打包 `plugin.json`、`index.mjs`、`README.md`、`ui.json`、`ui/**`、`lib/**`（过滤测试、快照、sourcemap）；
 *   - 清单里的 `version` 可用 `--version` 覆盖（用于构造上一可用回滚包）。
 *
 * 自包含（W7）：仓库里适配层引用根 `lib/{core,modules,storage}`，而 `13 §5.8` 不允许把
 * `lib/adapter` 与引擎代码放在两个顶层目录。因此打包时把根 `lib` 的运行时目录平铺进
 * `lib/**`，并在写入 ZIP 前重写相对引用：
 *   - `index.mjs`：`'../../lib/` → `'./lib/`
 *   - `lib/adapter/**`：`'../../../../../lib/` → `'../../../lib/`
 */

import { readdir, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_SOURCE = join(ROOT, 'plugins', 'bio-mood-engine');
const LIMITS = Object.freeze({
  zip_bytes: 8 * 1024 * 1024,
  unpacked_bytes: 16 * 1024 * 1024,
  single_file_bytes: 4 * 1024 * 1024
});
const EXCLUDE_DIRS = new Set(['node_modules', 'tests', 'test', '__tests__', '.git', '.cache']);
const EXCLUDE_EXT = new Set(['.map', '.log', '.snap', '.tmp']);
/** 文本类扩展名：写入 ZIP 前统一换行，产物不随检出/编辑器状态变化（P-15-06）。 */
const TEXT_EXT = new Set(['.mjs', '.js', '.json', '.md', '.html', '.css']);
/** 适配层真正依赖的根 `lib` 运行时目录（`lib/api` 不随插件发布）。 */
const RUNTIME_LIB_DIRS = Object.freeze(['core', 'modules', 'storage']);

function parseArgs(argv) {
  const args = { source: DEFAULT_SOURCE, out: null, version: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--out') {
      args.out = value;
      i += 1;
    } else if (flag === '--source') {
      args.source = value;
      i += 1;
    } else if (flag === '--version') {
      args.version = value;
      i += 1;
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  if (!args.out) throw new Error('--out is required');
  if (args.version !== null && !/^\d+\.\d+\.\d+$/.test(args.version)) {
    throw new Error('--version must be semver (e.g. 0.0.9)');
  }
  return args;
}

async function listFiles(dir, base = dir) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      out.push(...(await listFiles(full, base)));
      continue;
    }
    if (!entry.isFile()) continue;
    if (EXCLUDE_EXT.has(entry.name.slice(entry.name.lastIndexOf('.')))) continue;
    out.push({ full, name: relative(base, full).split(sep).join('/') });
  }
  return out;
}

/** ZIP 只接受 `plugin.json` / `index.mjs` / `README.md` / `ui.json` / `ui/**` / `lib/**`。 */
function included(name) {
  if (name === 'plugin.json' || name === 'index.mjs' || name === 'README.md' || name === 'ui.json') return true;
  if (name.startsWith('ui/')) return true;
  if (name.startsWith('lib/')) return true;
  return false;
}

/** ZIP 内的文本条目统一为 LF；二进制条目原样打包。 */
function normalizeEol(name, data) {
  const dot = name.lastIndexOf('.');
  const ext = dot === -1 ? '' : name.slice(dot);
  if (!TEXT_EXT.has(ext)) return data;
  const text = data.toString('utf8');
  return text.includes('\r\n') ? Buffer.from(text.replace(/\r\n/g, '\n'), 'utf8') : data;
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

/** DOS 时间固定为 1980-01-01 00:00:00，保证同一输入产出同一字节。 */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

function zipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.data, { level: 9 });
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);

    offset += local.length + nameBytes.length + compressed.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

export async function packPlugin({ source = DEFAULT_SOURCE, version = null } = {}) {
  const pluginFiles = (await listFiles(source)).filter((file) => included(file.name));
  const runtimeFiles = [];
  for (const dir of RUNTIME_LIB_DIRS) {
    for (const file of await listFiles(join(ROOT, 'lib', dir), join(ROOT, 'lib'))) {
      runtimeFiles.push({ full: file.full, name: `lib/${file.name}` });
    }
  }
  const files = [...pluginFiles, ...runtimeFiles].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  );
  if (files.length === 0) throw new Error('no files to pack');

  const entries = [];
  const seen = new Set();
  let unpacked = 0;
  for (const file of files) {
    if (seen.has(file.name)) throw new Error(`duplicate entry in package: ${file.name}`);
    seen.add(file.name);
    let data = normalizeEol(file.name, await readFile(file.full));
    if (version && file.name === 'plugin.json') {
      const manifest = JSON.parse(data.toString('utf8'));
      manifest.version = version;
      data = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    }
    if (file.name === 'index.mjs') {
      data = Buffer.from(data.toString('utf8').split("'../../lib/").join("'./lib/"), 'utf8');
    } else if (file.name.startsWith('lib/adapter/')) {
      data = Buffer.from(
        data.toString('utf8').split("'../../../../../lib/").join("'../../../lib/"),
        'utf8'
      );
    }
    if (data.length > LIMITS.single_file_bytes) {
      throw new Error(`file exceeds 4 MiB: ${file.name} (${data.length} bytes)`);
    }
    const info = await stat(file.full);
    if (!info.isFile()) continue;
    unpacked += data.length;
    entries.push({ name: file.name, data });
  }
  if (unpacked > LIMITS.unpacked_bytes) {
    throw new Error(`unpacked size ${unpacked} exceeds 16 MiB`);
  }

  const zip = zipBuffer(entries);
  if (zip.length > LIMITS.zip_bytes) throw new Error(`zip size ${zip.length} exceeds 8 MiB`);

  return {
    zip,
    manifest: {
      version: version ?? JSON.parse(await readFile(join(source, 'plugin.json'), 'utf8')).version,
      zip_bytes: zip.length,
      unpacked_bytes: unpacked,
      files: entries.map((entry) => ({ path: entry.name, bytes: entry.data.length }))
    }
  };
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await packPlugin({ source: args.source, version: args.version });
    await mkdir(dirname(args.out), { recursive: true });
    await writeFile(args.out, result.zip);
    process.stdout.write(`${JSON.stringify({ ok: true, out: args.out, ...result.manifest }, null, 2)}\n`);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: err.message }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
