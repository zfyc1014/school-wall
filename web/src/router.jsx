/**
 * 极简 hash 路由。
 *
 * 为什么不用 react-router：整站只有 10 个页面、没有嵌套布局、不需要数据加载器，
 * 自己写 60 行比引一个 20KB 的依赖更划算（也是本项目「零第三方依赖」的延续）。
 *
 * 路径形态与 location.hash 的对应：
 *   '/'            → hash '#/'
 *   '/forum/12'    → hash '#/forum/12'
 *
 * 用 hash 而不是 history API：静态部署（面板/纯静态托管）下刷新任何一个子路径
 * 都不会 404，不需要服务端配 fallback 规则。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

function readHash() {
  const raw = String(window.location.hash || '').replace(/^#/, '');
  if (!raw) return '/';
  return raw.startsWith('/') ? raw : '/' + raw;
}

export function navigate(to, { replace = false } = {}) {
  const target = '#' + (String(to).startsWith('/') ? to : '/' + to);
  if (readHash() + '' === String(to)) return;
  if (replace) window.history.replaceState(null, '', target);
  else window.location.hash = target;
  // replaceState 不会触发 hashchange，手动通知一次
  if (replace) window.dispatchEvent(new HashChangeEvent('hashchange'));
}

/** 返回 { path, segments, params, query }；path 形如 '/forum/12' */
export function useRoute() {
  const [path, setPath] = useState(() => (typeof window === 'undefined' ? '/' : readHash()));

  useEffect(() => {
    const onChange = () => setPath(readHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return useMemo(() => {
    const [clean, search] = path.split('?');
    const segments = clean.split('/').filter(Boolean);
    const query = {};
    new URLSearchParams(search || '').forEach((value, key) => { query[key] = value; });
    return { path: clean, segments, query };
  }, [path]);
}

/** 滚动位置在切页时归零：否则从长列表进详情会停在半空中 */
export function useScrollTopOnRouteChange(path, disabled) {
  useEffect(() => {
    if (disabled) return;
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  }, [path, disabled]);
}

export function Link({ to, children, className, onClick, ...rest }) {
  const handle = useCallback((event) => {
    if (onClick) onClick(event);
    if (event.defaultPrevented) return;
    event.preventDefault();
    navigate(to);
  }, [to, onClick]);

  return (
    <a href={'#' + to} className={className} onClick={handle} {...rest}>
      {children}
    </a>
  );
}
