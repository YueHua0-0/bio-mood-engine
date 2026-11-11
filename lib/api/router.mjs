/**
 * 12 §4.1：路由表与请求分发。只做"方法 + 路径"匹配，不做校验或业务。
 */

const ROUTES = Object.freeze([
  { name: 'events', method: 'POST', pattern: /^\/v1\/events$/ },
  { name: 'state', method: 'GET', pattern: /^\/v1\/state\/([^/]+)$/ },
  { name: 'tick', method: 'POST', pattern: /^\/v1\/tick$/ },
  { name: 'admin_reset', method: 'POST', pattern: /^\/v1\/admin\/reset$/ },
  { name: 'health', method: 'GET', pattern: /^\/health$/ },
  { name: 'version', method: 'GET', pattern: /^\/version$/ }
]);

/** 12 §5.1：这两个端点跳过角色白名单与限流，但仍要求令牌。 */
export const PUBLIC_ROUTES = Object.freeze(new Set(['health', 'version']));

/** 需要 body 且需要按 operation 分支校验的 POST 端点。 */
export const BODY_ROUTES = Object.freeze(new Set(['events', 'tick', 'admin_reset']));

export function pathnameOf(rawUrl) {
  const url = typeof rawUrl === 'string' && rawUrl.length > 0 ? rawUrl : '/';
  const queryIndex = url.indexOf('?');
  const path = queryIndex === -1 ? url : url.slice(0, queryIndex);
  return path.length > 0 ? path : '/';
}

/**
 * @returns {{name: string, params: {characterId?: string}}|null}
 */
export function matchRoute(method, pathname) {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const match = route.pattern.exec(pathname);
    if (!match) continue;
    const params = {};
    if (route.name === 'state') params.characterId = decodeURIComponent(match[1]);
    return { name: route.name, params };
  }
  return null;
}

export { ROUTES };
