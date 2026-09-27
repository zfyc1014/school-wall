import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { loadTurnstile } from '../lib/turnstile.js';

/**
 * Turnstile widget（托管模式）。
 *
 * 用 `onToken` 把最新 token 交给上层：token 单次有效，用完必须 reset 才能再拿。
 * `interactionOnly` 交给 Cloudflare 决定是否需要用户点一下（默认由后台配置决定）。
 *
 * 注意：验证失败时不要把用户挡死在页面上 —— 回调只上报状态，
 * 由调用方决定是提示重试还是降级（容器模式可在无 JS 时退化）。
 */
export function Turnstile({
  siteKey,
  onToken,
  onError,
  onExpire,
  theme = 'light',
  size = 'flexible',
  action = 'turnstile-spin-v2',
  className = '',
  autoResetOnExpire = true,
}) {
  const holder = useRef(null);
  const widgetId = useRef(null);
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [message, setMessage] = useState('');
  const domId = useId().replace(/[:]/g, '_');
  const callbacks = useRef({ onToken, onError, onExpire });
  callbacks.current = { onToken, onError, onExpire };

  useEffect(() => {
    let cancelled = false;

    loadTurnstile()
      .then((turnstile) => {
        if (cancelled || !holder.current || widgetId.current !== null) return;
        widgetId.current = turnstile.render(holder.current, {
          sitekey: siteKey,
          theme,
          size,
          action,
          language: 'zh-cn',
          callback: (token) => {
            setStatus('ready');
            setMessage('');
            callbacks.current.onToken?.(token);
          },
          'expired-callback': () => {
            setStatus('loading');
            callbacks.current.onToken?.('');
            callbacks.current.onExpire?.();
            if (autoResetOnExpire && widgetId.current !== null) {
              try { turnstile.reset(widgetId.current); } catch { /* ignore */ }
            }
          },
          'timeout-callback': () => {
            callbacks.current.onToken?.('');
            callbacks.current.onExpire?.();
          },
          'error-callback': (code) => {
            setStatus('error');
            const text = `人机验证加载失败${code ? `（${code}）` : ''}`;
            setMessage(text);
            callbacks.current.onToken?.('');
            callbacks.current.onError?.(text);
          },
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setStatus('error');
        setMessage(err?.message || '人机验证加载失败');
        callbacks.current.onError?.(err?.message || '');
      });

    return () => {
      cancelled = true;
      const turnstile = typeof window !== 'undefined' ? window.turnstile : null;
      if (turnstile && widgetId.current !== null) {
        try { turnstile.remove(widgetId.current); } catch { /* ignore */ }
      }
      widgetId.current = null;
    };
  }, [siteKey, theme, size, action, autoResetOnExpire]);

  return (
    <div className={`turnstile-slot ${className}`.trim()} id={domId} data-status={status}>
      <div ref={holder} />
      {status === 'loading' && <p className="meta turnstile-hint">正在加载人机验证…</p>}
      {status === 'error' && <p className="err">{message}</p>}
    </div>
  );
}

/** 供上层主动重置 widget（token 过期、提交失败重试等场景） */
export function useTurnstileReset() {
  return useCallback(() => {
    const turnstile = typeof window !== 'undefined' ? window.turnstile : null;
    if (!turnstile) return;
    try {
      turnstile.reset();
    } catch {
      /* 未渲染时忽略 */
    }
  }, []);
}
