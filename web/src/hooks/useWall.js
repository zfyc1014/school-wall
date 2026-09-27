import { useRef, useState } from 'react';
import { PAGE_SIZE } from '../lib/types.js';

const EMPTY_PAGE = { items: [], nextCursor: null };

/**
 * 信息流状态机：筛选 / 排序 / 搜索 / 游标分页 / 点赞 / 举报。
 * 数据来源由 adapter 决定，本 hook 不关心是 /api 还是 localStorage。
 *
 * @param {object} options
 * @param {any} options.adapter
 * @param {boolean} options.ready  适配器探测完成后才加载
 * @param {(msg: string) => void} options.toast
 * @param {Set<string>} options.likedIds
 * @param {(next: Set<string>) => void} options.setLikedIds
 */
export function useWall({ adapter, ready, toast, likedIds, setLikedIds }) {
  const [items, setItems] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [cat, setCat] = useState('全部');
  const [sort, setSort] = useState('new');
  const [q, setQ] = useState('');
  const [popId, setPopId] = useState(null);
  /** 待举报的帖子 id：由 UI 层托管成弹层开关状态 */
  const [reportTarget, setReportTarget] = useState(null);

  const seq = useRef(0);
  const abortRef = useRef(null);

  function cancelInflight() {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }

  /** 首页加载：筛选/排序/搜索变化或重试时调用 */
  async function load() {
    if (!adapter) return;
    const token = ++seq.current;
    cancelInflight();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError('');
    try {
      const page = await adapter.listPosts({ cat, sort, q, cursor: null, signal: controller.signal });
      if (token !== seq.current) return; // 已被更新的请求取代
      setItems(applyLiked(page.items));
      setCursor(page.nextCursor);
    } catch (err) {
      if (err?.name === 'AbortError') return;
      if (token !== seq.current) return;
      setError(err?.message || '加载失败');
      setItems([]);
      setCursor(null);
    } finally {
      if (token === seq.current) setLoading(false);
    }
  }

  /** 游标翻页，旧数据保留 */
  async function loadMore() {
    if (!adapter || !cursor || loadingMore) return;
    setLoadingMore(true);
    setError('');
    try {
      const page = await adapter.listPosts({ cat, sort, q, cursor });
      setItems((prev) => [...prev, ...applyLiked(page.items).filter((p) => !prev.some((x) => String(x.id) === String(p.id)))]);
      setCursor(page.nextCursor);
    } catch (err) {
      setError(err?.message || '加载失败');
    } finally {
      setLoadingMore(false);
    }
  }

  function applyLiked(list) {
    return list.map((p) => ({ ...p, liked: likedIds.has(String(p.id)) }));
  }

  /** 「我点过赞」是本机记忆：后端只回计数 */
  async function toggleLike(id) {
    const key = String(id);
    const target = items.find((p) => String(p.id) === key);
    if (!target || !adapter) return;
    const optimistic = !target.liked;

    // 先动，失败再回滚——互动要立刻有反馈
    setItems((prev) => prev.map((p) => (String(p.id) === key
      ? { ...p, liked: optimistic, likes: Math.max(0, p.likes + (optimistic ? 1 : -1)) }
      : p)));
    setPopId(key);
    setTimeout(() => setPopId((cur) => (cur === key ? null : cur)), 240);

    const next = new Set(likedIds);
    if (optimistic) next.add(key);
    else next.delete(key);
    setLikedIds(next);

    try {
      const res = await adapter.toggleLike(id, { liked: optimistic });
      setItems((prev) => prev.map((p) => (String(p.id) === key ? { ...p, liked: res.liked, likes: res.likes } : p)));
      const authoritative = new Set(next);
      if (res.liked) authoritative.add(key);
      else authoritative.delete(key);
      setLikedIds(authoritative);
    } catch (err) {
      setItems((prev) => prev.map((p) => (String(p.id) === key
        ? { ...p, liked: target.liked, likes: target.likes }
        : p)));
      const rollback = new Set(likedIds);
      setLikedIds(rollback);
      toast(err?.message || '操作失败，请稍后再试');
    }
  }

  /**
   * 通知—移除机制的入口：点「举报」只做一件事 —— 打开举报弹层收集理由。
   * 真正落工单由 App 的 submitReport → adapter.createReport 完成，
   * 避免「点一下就直接投诉」这种不可撤销、也收集不到理由的行为。
   */
  function requestReport(id) {
    if (!adapter) return;
    setReportTarget(id);
  }

  function clearReportTarget() {
    setReportTarget(null);
  }

  /** 本地演示数据用满 8 条后可以恢复出厂 */
  async function resetDemo() {
    if (typeof adapter?.reset !== 'function') return;
    adapter.reset();
    await load();
    toast('已恢复演示数据');
  }

  /** 墙上的评论计数由本 hook 统一维护（发帖/评论后同步） */
  function patchCommentCount(id, nextCount) {
    setItems((prev) => prev.map((p) => (String(p.id) === String(id) ? { ...p, comments: nextCount } : p)));
  }

  return {
    adapter,
    items,
    cursor,
    loading,
    loadingMore,
    error,
    cat,
    sort,
    q,
    popId,
    reportTarget,
    clearReportTarget,
    empty: !loading && !error && items.length === 0,
    setCat,
    setSort,
    setQ,
    load,
    loadMore,
    toggleLike,
    requestReport,
    resetDemo,
    patchCommentCount,
    pageSize: PAGE_SIZE,
  };
}
