#!/usr/bin/env node
/**
 * W0 文档一致性闸门（台账 §10.3 规则 2）。
 *
 * 1. 扫描 docs/NN-*.md 中所有具体文件路径（lib/ tests/ tools/ docs/），核对是否存在；
 * 2. 扫描所有以 `| ID |` 开头的表行，核对用例编号是否出现在 tests/** 的 test 标题中；
 * 3. 台账 §10.4 的白名单内条目跳过；
 * 4. 文档带「状态：未开工 / 部分未开工」标注时，整篇跳过编号校验；
 * 5. 白名单外有缺失 → 退出码 1；白名单项已落地 → 提示可移除，不算失败。
 *
 * 用法：node tools/check-docs.mjs
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOCS = join(ROOT, 'docs');
const LEDGER = join(DOCS, '冲突报告与问题台账_已验证.md');

/** 允许可选的 plugins/bio-mood-engine/ 前缀，避免把插件内路径误判为仓库根路径。 */
const PATH_RE = /\b(?:(?:plugins\/bio-mood-engine\/)?(?:lib|tests|tools|docs)\/[A-Za-z0-9_\-./{}*]+\.(?:mjs|json|md))/g;
const ID_ROW_RE = /^\|\s*([A-Z]\d{2}[a-z]?)\s*\|/;
const UNSTARTED_RE = /^>\s*状态：(?:部分)?未开工/;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** 读取台账 §10.4 的路径白名单与编号白名单。 */
function loadWhitelist() {
  const text = readFileSync(LEDGER, 'utf8');
  const start = text.indexOf('### 10.4');
  const end = text.indexOf('### 10.5');
  if (start < 0 || end < 0) throw new Error('台账缺少 §10.4 / §10.5，无法读取白名单');

  const paths = new Set();
  const ids = new Set();
  let mode = 'path';
  for (const raw of text.slice(start, end).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('```') || line.length === 0) continue;
    if (line.startsWith('#')) {
      mode = line.includes('用例') ? 'id' : 'path';
      continue;
    }
    if (mode === 'path') {
      const path = line.split('#')[0].trim();
      if (path) paths.add(path);
    } else {
      for (const id of line.split(/\s+/)) ids.add(id);
    }
  }
  return { paths, ids };
}

const { paths: pathWhitelist, ids: idWhitelist } = loadWhitelist();

const docFiles = readdirSync(DOCS).filter((name) => /^\d\d-.*\.md$/.test(name));
const docTexts = new Map(
  docFiles.map((file) => [file, readFileSync(join(DOCS, file), 'utf8').split(/\r?\n/)])
);

const skippedDocs = docFiles.filter((file) =>
  docTexts.get(file).some((line) => UNSTARTED_RE.test(line))
);

const missingPaths = [];
for (const file of docFiles) {
  docTexts.get(file).forEach((line, index) => {
    for (const match of line.matchAll(PATH_RE)) {
      const path = match[0];
      if (/[*{}]/.test(path)) continue;
      if (existsSync(join(ROOT, path)) || pathWhitelist.has(path)) continue;
      missingPaths.push(`${file}:${index + 1}  ${path}`);
    }
  });
}

const testFiles = existsSync(join(ROOT, 'tests'))
  ? walk(join(ROOT, 'tests')).filter((file) => file.endsWith('.test.mjs'))
  : [];
const testTitles = testFiles
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n')
  .matchAll(/test\(\s*(['"`])([\s\S]*?)\1/g);
const titleText = [...testTitles].map((match) => match[2]).join('\n');

const missingIds = [];
for (const file of docFiles) {
  if (skippedDocs.includes(file)) continue;
  const seen = new Set();
  let inTestSection = false;
  docTexts.get(file).forEach((line, index) => {
    // 只核对「测试要求」章节；00 的不变量表、01 的检查项表不是 node:test 用例。
    if (/^##\s/.test(line)) {
      inTestSection = /^##\s+\d+\.\s*测试要求/.test(line);
      return;
    }
    if (!inTestSection) return;
    const match = line.match(ID_ROW_RE);
    if (!match) return;
    const id = match[1];
    if (seen.has(id) || idWhitelist.has(id)) return;
    seen.add(id);
    if (!new RegExp(`\\b${id}\\b`).test(titleText)) {
      missingIds.push(`${file}:${index + 1}  ${id}`);
    }
  });
}

const staleWhitelist = [...pathWhitelist].filter((path) => existsSync(join(ROOT, path)));

console.log('文档一致性核对（check-docs）');
console.log(`- 文档：${docFiles.length} 篇；跳过编号校验（未开工）：${skippedDocs.join('、') || '无'}`);
console.log(`- 白名单：路径 ${pathWhitelist.size} 条 / 编号 ${idWhitelist.size} 个`);

if (missingPaths.length > 0) {
  console.log(`\n缺失路径（${missingPaths.length}）：`);
  for (const item of missingPaths) console.log(`  ✗ ${item}`);
} else {
  console.log('\n缺失路径：0');
}

if (missingIds.length > 0) {
  console.log(`\n缺失用例编号（${missingIds.length}）：`);
  for (const item of missingIds) console.log(`  ✗ ${item}`);
} else {
  console.log('缺失用例编号：0');
}

if (staleWhitelist.length > 0) {
  console.log(`\n可移除的白名单（文件已落地）：`);
  for (const path of staleWhitelist) console.log(`  · ${path}`);
}

const failed = missingPaths.length > 0 || missingIds.length > 0;
console.log(`\n结论：${failed ? 'FAIL' : 'PASS'}`);
process.exitCode = failed ? 1 : 0;
