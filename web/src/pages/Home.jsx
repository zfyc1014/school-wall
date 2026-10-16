import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { Announcement } from '../components/Announcement.jsx';
import { PostCard } from '../components/PostCard.jsx';
import { Empty, ErrorState, Loading } from '../components/Empty.jsx';
import { IconSearch, IconClose } from '../components/icons.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';

/** 表白墙分类：与后端 cleanCat 的白名单一致 */
export const CATS = ['全部', '表白', '树洞', '寻人', '失物', '致谢'];
const PAGE_SIZE = 20;

/**
 * 首页。
 *
 * 「主界面要简洁，尽量少留信息」—— 所以这里只有四样东西：
 *   站名 + 搜索、公告栏、分类/排序、信息流。
 * 没有 hero、没有标语、没有页脚长文、没有数据源说明。
 */
export function HomePage({ site, onCompose, refreshToken }) {
  const toast = useToast();
  const { requireLogin, user } = useAuth();

  const [cat, setCat] = useState('全部');
  const [sort, setSort] = useState('new');
  const [searchOpen, setSearchOpen] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [q, setQ] = useState('');

  const [items, setItems] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [liked, setLiked] = useState(() => new Set());

  // 搜索输入防抖：每敲一个字就发一次请求既浪费也会让列表闪
  useEffect(() => {
    const timer = setTimeout(() => setQ(keyword.trim()), 320);
    return () => clearTimeout(timer);
  }, [keyword]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.posts.list({
        cat: cat === '全部' ? '' : cat,
        sort,
        q,
        limit: PAGE_SIZE
      });
      setItems(Array.isArray(data.items) ? data.items : []);
      setCursor(data.nextCursor || null);
      // 后端会返回「我是否点过赞」，但帖子列表接口不带登录态语义，
      // 因此本地记一份，保证刷新前后心形状态一致（服务端已按用户去重）。
      setLiked((prev) => {
        const next = new Set(prev);
        (data.items || []).forEach((item) => {
          if (item.liked) next.add(String(item.id));
          else next.delete(String(item.id));
        });
        return next;
      });
    } catch (err) {
      setError(err.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [cat, sort, q]);

  useEffect(() => { load(); }, [load, refreshToken]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await api.posts.list({
        cat: cat === '全部' ? '' : cat,
        sort,
        q,
        cursor,
        limit: PAGE_SIZE
      });
      setItems((prev) => prev.concat(data.items || []));
      setCursor(data.nextCursor || null);
    } catch (err) {
      toast(err.message || '加载失败');
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, cat, sort, q, toast]);

  const toggleLike = useCallback((post) => {
    requireLogin(async () => {
      try {
        const result = await api.posts.like(post.id);
        setLiked((prev) => {
          const next = new Set(prev);
          if (result.liked) next.add(String(post.id));
          else next.delete(String(post.id));
          return next;
        });
        setItems((prev) => prev.map((item) => (
          String(item.id) === String(post.id) ? { ...item, likes: result.likes } : item
        )));
      } catch (err) {
        toast(err.message || '操作失败');
      }
    });
  }, [requireLogin, toast]);

  const openComments = useCallback((post) => {
    requireLogin(() => {
      // 评论在卡片内展开，这里只是要求登录后再展开
      setItems((prev) => prev.map((item) => (
        String(item.id) === String(post.id) ? { ...item, __open: true } : item
      )));
    });
  }, [requireLogin]);

  const report = useCallback((post) => {
    requireLogin(async () => {
      const reason = window.prompt('举报理由（可留空）') || '';
      try {
        await api.posts.report(post.id, reason);
        toast('举报已提交，我们会尽快核查');
      } catch (err) {
        toast(err.message || '举报失败');
      }
    });
  }, [requireLogin, toast]);

  const header = useMemo(() => (
    <div className="home-head">
      <div className="container spread">
        {searchOpen ? (
          <div className="row grow">
            <input
              className="input"
              style={{ minHeight: 36, padding: '6px 12px' }}
              placeholder="搜索墙上的内容"
              value={keyword}
              autoFocus
              onChange={(event) => setKeyword(event.target.value)}
            />
            <button
              className="btn-icon"
              type="button"
              aria-label="关闭搜索"
              onClick={() => { setSearchOpen(false); setKeyword(''); }}
            >
              <IconClose size={18} />
            </button>
          </div>
        ) : (
          <>
            <div>
              <h1 className="home-title">{site.siteName}</h1>
              {/* 只显示学校：自己叫什么自己知道，首页不放重复信息 */}
              {user && user.school ? <p className="home-sub">{user.school}</p> : null}
            </div>
            <button className="btn-icon" type="button" aria-label="搜索" onClick={() => setSearchOpen(true)}>
              <IconSearch size={20} />
            </button>
          </>
        )}
      </div>
    </div>
  ), [searchOpen, keyword, site.siteName, user]);

  return (
    <div className="container">
      {header}

      <Announcement items={site.announcements} />

      <div className="spread" style={{ marginTop: 12, gap: 12 }}>
        <div className="chips grow" role="group" aria-label="分类">
          {CATS.map((item) => (
            <button
              key={item}
              className="chip"
              type="button"
              aria-pressed={cat === item}
              onClick={() => setCat(item)}
            >
              {item}
            </button>
          ))}
        </div>
        <div className="seg" role="tablist" aria-label="排序">
          <button type="button" role="tab" aria-selected={sort === 'new'} onClick={() => setSort('new')}>最新</button>
          <button type="button" role="tab" aria-selected={sort === 'hot'} onClick={() => setSort('hot')}>最热</button>
        </div>
      </div>

      <section className="feed" aria-live="polite">
        {loading && items.length === 0 ? <Loading rows={3} /> : null}

        {error && !loading ? <ErrorState message={error} onRetry={load} /> : null}

        {!loading && !error && items.length === 0 ? (
          <Empty
            title={q ? '没有找到相关内容' : '这里还很安静'}
            hint={q ? '换个关键词试试' : '第一条告白，等你来写'}
            action={!q ? (
              <button className="btn btn-primary" type="button" onClick={onCompose}>发布表白</button>
            ) : null}
          />
        ) : null}

        {items.map((post) => (
          <PostCard
            key={post.id}
            post={post}
            liked={liked.has(String(post.id))}
            onLike={toggleLike}
            onComment={openComments}
            onReport={report}
          />
        ))}

        {cursor && !loading ? (
          <div className="feed-status">
            <button className="btn btn-secondary btn-sm" type="button" disabled={loadingMore} onClick={loadMore}>
              {loadingMore ? '加载中…' : '加载更多'}
            </button>
          </div>
        ) : null}

        {!loading && !cursor && items.length > 0 ? (
          <p className="feed-end">已经到底了</p>
        ) : null}
      </section>
    </div>
  );
}

export default HomePage;
