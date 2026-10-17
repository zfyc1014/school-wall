import { useEffect, useRef } from 'react';
import { loadTurnstile, describeTurnstileError } from '../lib/turnstile.js';

/**
 * Turnstile widget。
 *
 * 三个容易做错的点，这里都按官方要求处理了：
 *   1. **显式渲染并保存 widget id**：token 是一次性的，提交失败后要 reset 才能重试；
 *   2. **token 通过回调交给父组件**，而不是从 DOM 里读隐藏 input —— React 里读 DOM 更脆；
 *   3. **卸载时 remove**：SPA 反复开关弹层，不清理会残留 iframe 和事件。
 *
 * 父组件用 resetSignal 递增来要求「重置」，覆盖网络失败、校验失败、服务端报错等所有路径。
 */
export function Turnstile({ siteKey, action, onToken, onError, resetSignal = 0, theme = 'auto' }) {
  const containerRef = useRef(null);
  const widgetIdRef = useRef(null);
  const onTokenRef = useRef(onToken);
  const onErrorRef = useRef(onError);
  onTokenRef.current = onToken;
  onErrorRef.current = onError;

  // 渲染（siteKey / action 变化时重建）
  useEffect(() => {
    let cancelled = false;
    if (!siteKey) return undefined;

    loadTurnstile()
      .then((ts) => {
        if (cancelled || !ts || !containerRef.current) return;
        widgetIdRef.current = ts.render(containerRef.current, {
          sitekey: siteKey,
          action,
          theme,
          callback: (token) => onTokenRef.current && onTokenRef.current(token),
          'expired-callback': () => onTokenRef.current && onTokenRef.current(''),
          'error-callback': (code) => {
            onTokenRef.current && onTokenRef.current('');
            // 把 110200 这类数字码翻成「该去哪改」，否则页面上只会显示一串数字
            onErrorRef.current && onErrorRef.current(describeTurnstileError(code || 'widget_error'));
          }
        });
      })
      .catch((err) => {
        if (!cancelled && onErrorRef.current) onErrorRef.current(err.message);
      });

    return () => {
      cancelled = true;
      const ts = typeof window !== 'undefined' ? window.turnstile : null;
      if (ts && widgetIdRef.current !== null) {
        try { ts.remove(widgetIdRef.current); } catch { /* 已经移除过 */ }
        widgetIdRef.current = null;
      }
    };
  }, [siteKey, action, theme]);

  // 父组件要求重置：换一个新的 widget 实例最稳（reset 在某些失败态下不会清掉错误提示）
  useEffect(() => {
    if (!resetSignal) return;
    const ts = typeof window !== 'undefined' ? window.turnstile : null;
    if (ts && widgetIdRef.current !== null) {
      try { ts.reset(widgetIdRef.current); } catch { /* ignore */ }
    }
  }, [resetSignal]);

  if (!siteKey) return null;
  return <div ref={containerRef} className="turnstile-slot" />;
}

export default Turnstile;
