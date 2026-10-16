import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, setLoginHandler } from '../api/client.js';

/**
 * 登录态（全站唯一来源）。
 *
 * 三个约定：
 *   1. 首屏先打 /api/auth/me 决定是否已登录；ready=false 时不要渲染需要登录的东西；
 *   2. 任何接口返回 401 login_required 时，客户端会把登录弹层打开（见 client.js）；
 *   3. 需要登录才能做的事用 requireLogin(fn)：未登录先弹登录，登录成功后**自动接着做**
 *      —— 这样「点赞 → 登录 → 点赞成功」是一次连续体验，不需要用户重新点一遍。
 */

const AuthContext = createContext(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return ctx;
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const pending = useRef(null); // 登录成功后要接着执行的动作

  const refresh = useCallback(async () => {
    try {
      const data = await api.auth.me();
      setUser(data && data.user ? data.user : null);
      return data && data.user ? data.user : null;
    } catch {
      setUser(null);
      return null;
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // 客户端遇到 login_required 会调这里：保留现场（挂起动作）并弹登录
  useEffect(() => {
    setLoginHandler(() => setAuthOpen(true));
    return () => setLoginHandler(null);
  }, []);

  const openAuth = useCallback(() => setAuthOpen(true), []);
  const closeAuth = useCallback(() => {
    setAuthOpen(false);
    pending.current = null; // 用户主动关掉弹层：放弃挂起的动作
  }, []);

  /** 登录/注册成功后由 AuthSheet 调用 */
  const completeAuth = useCallback((nextUser) => {
    setUser(nextUser);
    setAuthOpen(false);
    const action = pending.current;
    pending.current = null;
    if (typeof action === 'function') {
      // 放到下一个 tick：让状态先落地，避免动作里读到的还是旧的 user
      setTimeout(() => { try { action(); } catch { /* 动作失败不影响登录 */ } }, 0);
    }
  }, []);

  const logout = useCallback(async () => {
    try { await api.auth.logout(); } catch { /* 本地状态照样清 */ }
    setUser(null);
  }, []);

  const requireLogin = useCallback((action) => {
    if (user) {
      if (typeof action === 'function') action();
      return true;
    }
    if (typeof action === 'function') pending.current = action;
    setAuthOpen(true);
    return false;
  }, [user]);

  /** 局部更新用户（改昵称/头像/经验变化后调用，避免整页重新拉取） */
  const updateUser = useCallback((patch) => {
    setUser((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const value = useMemo(() => ({
    user, ready, authOpen, refresh, logout, updateUser, requireLogin, openAuth, closeAuth, completeAuth
  }), [user, ready, authOpen, refresh, logout, updateUser, requireLogin, openAuth, closeAuth, completeAuth]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
