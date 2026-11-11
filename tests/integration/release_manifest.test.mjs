/**
 * 15 §5.7 / §8 V03–V05：发布清单、包体积、权限与自包含校验。
 *
 * 只用真实产物：`packPlugin()` 现打现比 + `release/*.zip` 字节一致性。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { posix } from 'node:path/posix';
import { fileURLToPath } from 'node:url';

import { packPlugin } from '../../scripts/pack-plugin.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const PLUGIN_DIR = join(ROOT, 'plugins', 'bio-mood-engine');
const LIMITS = Object.freeze({
  zip_bytes: 8 * 1024 * 1024,
  unpacked_bytes: 16 * 1024 * 1024,
  single_file_bytes: 4 * 1024 * 1024
});
const FORBIDDEN_PREFIXES = ['tests/', 'docs/', 'node_modules/', '.git/', 'release/'];
const FORBIDDEN_FILES = new Set(['package.json', 'package-lock.json', '.env']);

async function readManifest() {
  return JSON.parse(await readFile(join(PLUGIN_DIR, 'plugin.json'), 'utf8'));
}

/** 打包时的路径重写规则（与 `scripts/pack-plugin.mjs` 保持一致）。 */
function sourceTextFor(entryPath) {
  if (entryPath === 'index.mjs') {
    return {
      file: join(PLUGIN_DIR, 'index.mjs'),
      rewrite: (text) => text.split("'../../lib/").join("'./lib/")
    };
  }
  if (entryPath.startsWith('lib/adapter/')) {
    return {
      file: join(PLUGIN_DIR, entryPath),
      rewrite: (text) => text.split("'../../../../../lib/").join("'../../../lib/")
    };
  }
  if (/^lib\/(core|modules|storage)\//.test(entryPath)) {
    return { file: join(ROOT, entryPath), rewrite: (text) => text };
  }
  return null;
}

function specifiersOf(text) {
  const found = new Set();
  const re = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)'([^']+)'/g;
  let match = re.exec(text);
  while (match) {
    found.add(match[1]);
    match = re.exec(text);
  }
  return [...found];
}

test('plugin.json：版本、权限最小集、configSchema 上限与安全默认（V04）', async () => {
  const manifest = await readManifest();
  assert.equal(manifest.id, 'bio-mood-engine');
  assert.equal(manifest.host, 'wechatagent');
  assert.equal(manifest.apiVersion, 2);
  assert.equal(typeof manifest.apiVersion, 'number');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(manifest.description.length >= 1 && manifest.description.length <= 1024);

  assert.deepEqual([...manifest.permissions].sort(), ['history_read', 'reply', 'storage']);

  const schema = manifest.configSchema;
  assert.equal(Object.hasOwn(schema, 'type'), false);
  assert.equal(Object.hasOwn(schema, 'properties'), false);
  assert.equal(Object.hasOwn(schema, 'additionalProperties'), false);
  const keys = Object.keys(schema);
  assert.ok(keys.length <= 24, `configSchema 项数 ${keys.length} > 24`);
  assert.deepEqual(keys.sort(), Object.keys(manifest.settings).sort());

  assert.equal(schema.masterSeedHex.secret, true);
  assert.equal(schema.engineRemoteToken.secret, true);
  assert.deepEqual(schema.engineMode.enum, ['embedded', 'remote']);
  assert.deepEqual(schema.afterResponseMode.enum, ['off', 'protocol']);
  assert.ok(schema.behaviorContextMaxChars.maximum <= 1500);
});

test('发布包：体积四项限额、包内清单与禁用目录（V03）', async () => {
  const { zip, manifest } = await packPlugin();
  assert.ok(zip.length <= LIMITS.zip_bytes, `zip ${zip.length} > 8 MiB`);
  assert.ok(manifest.unpacked_bytes <= LIMITS.unpacked_bytes, `unpacked ${manifest.unpacked_bytes} > 16 MiB`);

  const paths = manifest.files.map((file) => file.path);
  assert.equal(new Set(paths).size, paths.length, '包内路径必须唯一');
  for (const file of manifest.files) {
    assert.ok(file.bytes <= LIMITS.single_file_bytes, `${file.path} 超过 4 MiB`);
    for (const prefix of FORBIDDEN_PREFIXES) {
      assert.ok(!file.path.startsWith(prefix), `包内不得包含 ${file.path}`);
    }
    assert.ok(!FORBIDDEN_FILES.has(file.path), `包内不得包含 ${file.path}`);
    assert.ok(!file.path.endsWith('.map'), `包内不得包含 sourcemap：${file.path}`);
  }

  for (const required of [
    'plugin.json',
    'index.mjs',
    'README.md',
    'ui.json',
    'ui/page.html',
    'ui/page.js',
    'ui/style.css',
    'lib/adapter/wechatagent/tools.mjs',
    'lib/core/coordinator.mjs',
    'lib/modules/delivery/index.mjs',
    'lib/storage/repository.mjs'
  ]) {
    assert.ok(paths.includes(required), `缺少 ${required}`);
  }

  const depth = Math.max(...paths.map((file) => file.split('/').length));
  assert.ok(depth <= 8, `目录层级 ${depth} > 8`);
});

test('发布包自包含：包内相对引用全部可解析且无第三方依赖', async () => {
  const { manifest } = await packPlugin();
  const entries = new Set(manifest.files.map((file) => file.path));
  const modules = manifest.files.map((file) => file.path).filter((path) => path.endsWith('.mjs'));
  assert.ok(modules.length > 0);

  for (const entryPath of modules) {
    const source = sourceTextFor(entryPath);
    assert.ok(source !== null, `未知来源的包内模块：${entryPath}`);
    const text = source.rewrite(await readFile(source.file, 'utf8'));
    for (const specifier of specifiersOf(text)) {
      if (specifier.startsWith('node:')) continue;
      assert.ok(specifier.startsWith('.'), `${entryPath} 引用了非相对模块：${specifier}`);
      const resolved = posix.normalize(posix.join(posix.dirname(entryPath), specifier));
      assert.ok(entries.has(resolved), `${entryPath} → ${specifier} 解析为 ${resolved}，包内不存在`);
    }
  }
});

test('release/ 当前包与打包器逐字节一致，历史回滚包保留（V15）', async () => {
  const packed = await packPlugin();
  const current = await readFile(join(ROOT, 'release', 'bio-mood-engine-0.1.3.zip'));
  assert.ok(packed.zip.equals(current), 'bio-mood-engine-0.1.3.zip 与 packPlugin 输出不一致');
  const info = await stat(join(ROOT, 'release', 'bio-mood-engine-0.1.3.zip'));
  assert.equal(info.size, packed.zip.length);

  for (const file of ['bio-mood-engine-0.1.2.zip', 'bio-mood-engine-0.1.1.zip', 'bio-mood-engine-0.1.0.zip', 'bio-mood-engine-0.0.9.zip']) {
    const legacy = await stat(join(ROOT, 'release', file));
    assert.ok(legacy.size > 0, `${file} 缺失或为空`);
  }
});

test('文档齐备：CHANGELOG / 集成报告 / 运维手册与版本一致（V14）', async () => {
  const manifest = await readManifest();
  const changelog = await readFile(join(ROOT, 'CHANGELOG.md'), 'utf8');
  assert.ok(changelog.includes(manifest.version), 'CHANGELOG 未记录当前版本');
  assert.ok(changelog.includes('回滚'), 'CHANGELOG 缺少回滚方式');

  const report = await readFile(join(ROOT, 'docs', 'integration_report.md'), 'utf8');
  assert.ok(report.includes(manifest.version), '集成报告未标注版本');

  const runbook = await readFile(join(ROOT, 'docs', 'runbook.md'), 'utf8');
  assert.ok(runbook.includes('bootstrap'), '运维手册缺少 bootstrap 步骤');

  const readme = await readFile(join(PLUGIN_DIR, 'README.md'), 'utf8');
  assert.ok(readme.includes('虚构'), 'README 缺少虚构声明');
});
