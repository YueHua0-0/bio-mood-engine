/**
 * T18：`docs/test_report.md` 结构核对——必须给出实际数字，禁止只写"全部通过"。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const REPORT = readFileSync(new URL('../../docs/test_report.md', import.meta.url), 'utf8');

test('T18 测试报告：含执行命令、Node 版本、用例总数/通过/失败与实测数字', () => {
  assert.match(REPORT, /node --test/, '必须记录执行命令');
  assert.match(REPORT, /Node v\d+\.\d+\.\d+/, '必须记录 Node 版本');
  assert.match(REPORT, /总用例：\d+/);
  assert.match(REPORT, /通过：\d+/);
  assert.match(REPORT, /失败：\d+/);

  const total = Number(REPORT.match(/总用例：(\d+)/)[1]);
  const pass = Number(REPORT.match(/通过：(\d+)/)[1]);
  const fail = Number(REPORT.match(/失败：(\d+)/)[1]);
  assert.equal(pass + fail, total, '通过 + 失败 必须等于总数');
  assert.ok(total >= 373, `用例总数 ${total} 少于 W2 基线 373`);
  // P-15-07：允许记录失败，但必须逐项点名，禁止静默失败或只写"全部通过"。
  if (fail === 0) {
    assert.ok(REPORT.includes('无失败用例'), '0 失败时必须写明无失败用例');
  } else {
    const section7 = (REPORT.split('## 7.')[1] ?? '').split('## 8.')[0];
    const failed = [...section7.matchAll(/^\| (T\d{2}|M\d{2}) \|/gm)].map((m) => m[1]);
    assert.equal(
      new Set(failed).size,
      fail,
      `报告声明 ${fail} 项失败，§7 必须逐条列出失败编号（实际列出 ${new Set(failed).size} 项）`
    );
  }

  for (const keyword of ['纯 chunk', '端到端', '4320 步', 'nextU32', 'node --test 全量']) {
    assert.ok(REPORT.includes(keyword), `性能表缺少 ${keyword}`);
  }
  assert.match(REPORT, /覆盖率/);
  assert.match(REPORT, /发布证据矩阵/);
  assert.doesNotMatch(REPORT, /^全部通过$/, '不得只写"全部通过"');
});

test('T18 测试报告：T01–T21 全部编号可定位', () => {
  for (let index = 1; index <= 21; index += 1) {
    const code = `T${String(index).padStart(2, '0')}`;
    assert.ok(REPORT.includes(code), `报告缺少 ${code}`);
  }
});
