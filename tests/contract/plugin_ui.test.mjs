/**
 * P-13-18：插件状态页（`ui.json` + `ui/**`）与页面只读 action 的契约测试。
 *
 * 覆盖：宿主 UI 清单约束、静态文件边界、CSP 可执行性（无内联脚本/无外网/无 fetch），
 * 以及 `setup()` 真的注册了 `read-state` 并且能在页面 ctx 下返回状态。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { setup, ACTION_DEFINITIONS } from '../../plugins/bio-mood-engine/index.mjs';
import { makeCtx, eventParams } from '../integration/_plugin_helpers.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const PLUGIN_DIR = join(ROOT, 'plugins', 'bio-mood-engine');
const UI_DIR = join(PLUGIN_DIR, 'ui');

const UI_JSON_LIMIT = 8192;
const SINGLE_FILE_LIMIT = 4 * 1024 * 1024;

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

test('ui.json：版本、允许键、entry 与文案长度均符合宿主约束', async () => {
  const path = join(PLUGIN_DIR, 'ui.json');
  const info = await stat(path);
  assert.ok(info.size <= UI_JSON_LIMIT, `ui.json ${info.size} > 8192 B`);

  const ui = await readJson(path);
  assert.equal(ui.version, 1);
  for (const key of Object.keys(ui)) {
    assert.ok(['version', 'settings', 'page'].includes(key), `ui.json 出现宿主不允许的键：${key}`);
  }

  const page = ui.page;
  assert.equal(page.entry, 'page.html');
  assert.match(page.entry, /\.html$/);
  assert.ok(page.title.length >= 1 && page.title.length <= 40, 'page.title 必须 1–40 字');
  assert.ok(page.description.length >= 1 && page.description.length <= 200, 'page.description 必须 1–200 字');
});

test('ui 静态文件：三个文件存在、均在 ui/ 下且单文件 ≤ 4 MiB', async () => {
  for (const name of ['page.html', 'page.js', 'style.css']) {
    const path = join(UI_DIR, name);
    const info = await stat(path);
    assert.ok(info.isFile(), `${name} 必须是普通文件`);
    assert.ok(info.size <= SINGLE_FILE_LIMIT, `${name} ${info.size} 超过 4 MiB`);
  }
});

test('CSP 可执行性：无内联 script、无外网地址、page.js 只 import SDK 且无 fetch/eval', async () => {
  const html = await readFile(join(UI_DIR, 'page.html'), 'utf8');
  const js = await readFile(join(UI_DIR, 'page.js'), 'utf8');
  const css = await readFile(join(UI_DIR, 'style.css'), 'utf8');

  for (const [name, text] of [['page.html', html], ['page.js', js], ['style.css', css]]) {
    assert.ok(!/https?:\/\//i.test(text), `${name} 不得引用外部 URL`);
    assert.ok(!/\/\/cdn/i.test(text), `${name} 不得引用 CDN`);
  }

  assert.equal(html.match(/<script(?![^>]*\bsrc=)/gi), null, '页面不得包含内联 <script>');
  assert.match(html, /<script type="module" src="page\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="style\.css">/);

  const specifiers = [...js.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)'([^']+)'/g)].map((item) => item[1]);
  assert.deepEqual(specifiers, ['./__sdk.mjs'], 'page.js 只能 import 宿主 SDK');

  assert.ok(!/\bfetch\s*\(/.test(js), '页面禁止 fetch');
  assert.ok(!/XMLHttpRequest/.test(js), '页面禁止 XMLHttpRequest');
  assert.ok(!/\beval\s*\(/.test(js), '页面禁止 eval');
});

test('index.mjs：注册 read-state，参数为空对象 Schema 且不暴露 tick/admin', async () => {
  const source = await readFile(join(PLUGIN_DIR, 'index.mjs'), 'utf8');
  assert.match(source, /registerAction/);
  assert.ok(source.includes("id: 'read-state'"));

  assert.equal(ACTION_DEFINITIONS.length, 1);
  const def = ACTION_DEFINITIONS[0];
  assert.deepEqual(def.parameters, { type: 'object', properties: {}, additionalProperties: false });
  assert.ok(!/id: 'tick'/.test(JSON.stringify(def)), '页面 action 不得暴露 tick');
});

test('行为：setup 注册 read-state，假页面 ctx 下返回状态对象', async () => {
  const h = makeCtx();
  const actions = {};
  const api = {
    apiVersion: 2,
    ctx: h.ctx,
    logger: h.ctx.logger,
    clock: h.ctx.clock,
    registerTool() {},
    registerAction(action) {
      actions[action.id] = action;
    },
    registerHook() {}
  };

  const { tools } = setup(api);
  assert.equal(typeof actions['read-state'], 'object', 'setup 必须注册 read-state');
  assert.equal(typeof actions['read-state'].execute, 'function');

  const empty = await actions['read-state'].execute(h.ctx);
  assert.equal(empty.ok, true);
  assert.equal(empty.state_version, 0);
  assert.equal(empty.state_summary, null);

  const observed = await tools.observe(eventParams());
  assert.equal(observed.ok, true);

  const filled = await actions['read-state'].execute(h.ctx);
  assert.equal(filled.ok, true);
  assert.ok(filled.state_version >= 1);
  assert.equal(typeof filled.state_summary, 'object');
  assert.equal(typeof filled.state_summary.cycle.cycle_day, 'number');
  assert.equal(typeof filled.state_summary.sleep.sleep_debt, 'number');
  assert.equal(typeof filled.state_summary.stress.level, 'number');
  assert.equal(typeof filled.state_summary.mood.energy, 'number');
});
