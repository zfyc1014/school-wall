import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { navigate } from '../router.jsx';
import { Avatar } from '../components/Avatar.jsx';
import { UserBadge } from '../components/UserBadge.jsx';
import { Empty, ErrorState, Loading } from '../components/Empty.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { timeAgo } from '../lib/format.js';

/**
 * 论坛版块列表。
 *
 * 论坛是**署名讨论**（和匿名表白墙相反），所以每一条都带作者信息。
 * 浏览不需要登录：契约 §8.5 只要求写操作登录，这里刻意不碰 requireLogin，
 * 否则「先注册才能看帖」会把大部分新用户挡在门外。
 */

/**
 * 版块白名单，与后端 forum.BOARDS 同源。
 * 列表接口会在响应里回带 boards，但首屏请求还没回来时筛选行不能是空的，
 * 所以留一份兜底；接口一返回就以接口为准（运营加版块不用改前端）。
 */
const BOARDS = [
  { key: 'general', name: '综合' },
  { key: 'study', name: '学习' },
  { key: 'life', name: '生活' },
  { key: 'lost', name: '失物' }
];

/** 与后端 listThreads 的默认页大小一致（上限 50） */
const PAGE_SIZE = 20;

/** 列表项右下角的三项统计：回复 / 点赞 / 最后活跃 */
function ThreadStats({ thread }) {
  return (
    <span className="forum-stats meta">
      <span>{Number(thread.replyCount) || 0} 回复</span>
      <span>{Number(thread.likeCount) || 0} 赞</span>
      <span>{timeAgo(thread.lastReplyAt || thread.createdAt)}</span>
    </span>
  );
}

export function ForumPage() {
  const toast = useToast();

  const [boards, setBoards] = useState(BOARDS);
  const [board, setBoard] = useState('');
  const [sort, setSort] = useState('new');

  const [items, setItems] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  // 连续切版块时旧请求可能后到：用序号丢弃过期响应，否则列表会被上一个版块覆盖
  const seq = useRef(0);

  const chips = useMemo(() => [{ key: '', name: '全部' }].concat(boards), [boards]);

  const load = useCallback(async () => {
    const mine = (seq.current += 1);
    setLoading(true);
    setError('');
    // 换了筛选条件就先清空：留着上一批结果会让人以为筛选没生效
    setItems([]);
    setCursor(null);
    try {
      const data = await api.forum.threads({ board, sort, limit: PAGE_SIZE });
      if (mine !== seq.current) return;
      setItems(Array.isArray(data.items) ? data.items : []);
      setCursor(data.nextCursor || null);
      if (Array.isArray(data.boards) && data.boards.length) setBoards(data.boards);
    } catch (err) {
      if (mine !== seq.current) return;
      setError(err.message || '加载失败');
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [board, sort]);

  useEffect(() => { load(); }, [load]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await api.forum.threads({ board, sort, cursor, limit: PAGE_SIZE });
      // 追加而不是覆盖：分页失败时也要保住已经看到的列表
      setItems((prev) => prev.concat(data.items || []));
      setCursor(data.nextCursor || null);
    } catch (err) {
      toast(err.message || '加载失败');
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, board, sort, toast]);

  const openAuthor = useCallback((author) => {
    if (!author || !author.uuid) return;
    navigate('/u/' + author.uuid);
  }, []);

  return (
    <div className="container forum-page">
      <div className="page-head">
        <h1 className="page-title">论坛</h1>
      </div>

      <div className="forum-toolbar">
        <div className="chips grow forum-boards" role="group" aria-label="版块">
          {chips.map((item) => (
            <button
              key={item.key || 'all'}
              className="chip"
              type="button"
              aria-pressed={board === item.key}
              onClick={() => setBoard(item.key)}
            >
              {item.name}
            </button>
          ))}
        </div>
        <div className="seg forum-sort" role="tablist" aria-label="排序">
          <button type="button" role="tab" aria-selected={sort === 'new'} onClick={() => setSort('new')}>最新</button>
          <button type="button" role="tab" aria-selected={sort === 'hot'} onClick={() => setSort('hot')}>最热</button>
        </div>
      </div>

      <section className="forum-list" aria-live="polite">
        {loading && items.length === 0 ? <Loading rows={3} /> : null}

        {error && !loading ? <ErrorState message={error} onRetry={load} /> : null}

        {!loading && !error && items.length === 0 ? (
          <Empty
            title="这个版块还没有帖子，来发第一帖"
            hint="说点什么，让同学看见你"
            action={(
              <button className="btn btn-primary" type="button" onClick={() => navigate('/forum/new')}>
                发第一帖
              </button>
            )}
          />
        ) : null}

        {items.map((thread) => {
          const author = thread.author || null;
          return (
            <article key={thread.id} className="forum-thread">
              <button
                type="button"
                className="forum-thread-main"
                onClick={() => navigate('/forum/' + thread.id)}
              >
                <h3 className="forum-thread-title clamp-2">{thread.title}</h3>
                {thread.excerpt ? <p className="forum-thread-excerpt truncate">{thread.excerpt}</p> : null}
              </button>

              <div className="forum-thread-foot">
                <button
                  type="button"
                  className="forum-author"
                  onClick={() => openAuthor(author)}
                  aria-label={'查看 ' + ((author && author.nickname) || '匿名同学') + ' 的主页'}
                >
                  <Avatar user={author} size={22} />
                  <span className="forum-author-name">{(author && author.nickname) || '匿名同学'}</span>
                  <UserBadge user={author} variant="compact" />
                </button>
                <ThreadStats thread={thread} />
              </div>
            </article>
          );
        })}

        {cursor && !loading ? (
          <div className="forum-more">
            <button
              className="btn btn-secondary"
              type="button"
              disabled={loadingMore}
              onClick={loadMore}
            >
              {loadingMore ? '加载中…' : '加载更多'}
            </button>
          </div>
        ) : null}

        {!loading && !cursor && items.length > 0 ? (
          <p className="forum-more meta">已经到底了</p>
        ) : null}
      </section>
    </div>
  );
}

export default ForumPage;
