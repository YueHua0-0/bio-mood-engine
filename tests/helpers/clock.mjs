/**
 * 14 §4.2 的时钟替身：显式注入 `now`，不读取系统时钟。
 *
 * `fixedClock(iso)` 返回可调用对象，可直接作为仓库的 `clock` 或 API 的 `clock`；
 * 需要推进时用 `set(iso)` / `advanceSeconds(n)`，不使用定时器。
 */

import { parseTime, toIso } from '../../lib/core/clock.mjs';

export function isoAfter(iso, seconds) {
  return toIso(parseTime(iso, 'iso') + Math.round(seconds * 1000));
}

export function fixedClock(iso) {
  let current = iso;
  const clock = () => current;
  clock.set = (next) => {
    current = next;
  };
  clock.advanceSeconds = (seconds) => {
    current = isoAfter(current, seconds);
    return current;
  };
  clock.now = () => current;
  return clock;
}

/** 步进时钟：每次调用 `tick()` 前进固定秒数；用于循环推进的用例。 */
export function steppingClock(iso, stepSeconds = 3600) {
  const clock = fixedClock(iso);
  clock.step = stepSeconds;
  clock.tick = () => clock.advanceSeconds(stepSeconds);
  return clock;
}
