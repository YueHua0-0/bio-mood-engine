import test from 'node:test';
import assert from 'node:assert/strict';

import {
  composeContext,
  FICTION_DISCLAIMER
} from '../../plugins/bio-mood-engine/lib/adapter/wechatagent/hooks.mjs';
import { makeCtx, install, eventParams } from './_plugin_helpers.mjs';

function withDelay(storage, ms, onlyFirst = true) {
  const original = storage.get;
  let delayed = 0;
  storage.get = async (key) => {
    if (!onlyFirst || delayed === 0) {
      delayed += 1;
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
    return original(key);
  };
  return () => {
    storage.get = original;
  };
}

test('P06 before-context 注入 150 ms storage 延迟：总耗时 <800 ms，返回合法 {context}', async () => {
  const h = makeCtx();
  const { tools, hooks } = install(h.ctx);
  await tools.observe(eventParams());

  const restore = withDelay(h.storage, 150);
  const started = Date.now();
  let result;
  try {
    result = await hooks['before-context']({});
  } finally {
    restore();
  }
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 800, `钩子耗时 ${elapsed} ms`);
  assert.equal(typeof result.context, 'string');
  assert.ok(result.context.includes(FICTION_DISCLAIMER));
  assert.ok(result.context.length <= 800);
});

test('P07 before-context 内写 storage / 推进 / fetch 均不发生', async () => {
  const h = makeCtx();
  const { tools, hooks } = install(h.ctx);
  await tools.observe(eventParams());
  const beforeState = h.storage.raw('state');
  const beforeEvlog = h.storage.raw('evlog');

  const originalSet = h.storage.set;
  const originalDelete = h.storage.delete;
  const originalFetch = globalThis.fetch;
  let writes = 0;
  let fetches = 0;
  h.storage.set = async () => {
    writes += 1;
    throw new Error('hook must not write storage');
  };
  h.storage.delete = async () => {
    writes += 1;
    throw new Error('hook must not delete storage');
  };
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error('hook must not fetch');
  };

  let result;
  try {
    result = await hooks['before-context']({});
  } finally {
    h.storage.set = originalSet;
    h.storage.delete = originalDelete;
    globalThis.fetch = originalFetch;
  }

  assert.equal(writes, 0);
  assert.equal(fetches, 0);
  assert.equal(h.storage.raw('state'), beforeState, '钩子不得推进状态');
  assert.equal(h.storage.raw('evlog'), beforeEvlog, '钩子不得追加事件');
  assert.ok(result.context.includes(FICTION_DISCLAIMER));
});

test('P08 20 条超长文案：≤min(1500, max)，含完整免责声明，无数字与维度名', () => {
  const notes = Array.from({ length: 20 }, (_, i) => {
    const note = `第${i}条：energy=0.9 stress 很高 reply_likelihood + avoidance 100%`;
    return `${note}${'啰嗦'.repeat(30)}`;
  });

  for (const maxChars of [800, 1500]) {
    const context = composeContext({ notes, maxChars });
    assert.ok(context.length <= Math.min(1500, maxChars), `长度 ${context.length}`);
    assert.ok(context.includes(FICTION_DISCLAIMER), '必须含完整免责声明');
    assert.doesNotMatch(context, /[0-9０-９]/, '不得含数字');
    assert.doesNotMatch(
      context,
      /energy|stability|sensitivity|social_drive|closeness_need|mood|stress|sleep|reply_likelihood|avoidance|wake_cost/i
    );
    assert.doesNotMatch(context, /[+\-*/=<>%^×÷]/);
    const noteLines = context.split('\n').filter((line) => line !== FICTION_DISCLAIMER && line.length > 0);
    assert.ok(noteLines.length <= 3);
  }
});

test('P17 after-response 关闭返回 {}，开启前缀原样保留且只发送一次', () => {
  const h = makeCtx();
  const { hooks } = install(h.ctx);

  assert.deepEqual(hooks['after-response']({ text: 'SILENT' }), {});
  assert.deepEqual(hooks['after-response']({ text: 'RESPOND: 你好' }), {});

  h.config.afterResponseMode = 'protocol';
  assert.deepEqual(hooks['after-response']({ text: 'SILENT' }), { text: 'SILENT' });
  assert.deepEqual(hooks['after-response']({ text: 'RESPOND: 你好' }), { text: 'RESPOND: 你好' });
  assert.deepEqual(hooks['after-response']({ text: 'silent' }), {}, '大小写不得改写');
  assert.deepEqual(hooks['after-response']({ text: '普通回复' }), {});

  const once = hooks['after-response']({ text: 'RESPOND: 只发一次' });
  assert.deepEqual(Object.keys(once), ['text']);
});
