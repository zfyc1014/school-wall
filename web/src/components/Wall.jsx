import { PostCard } from './PostCard.jsx';
import { IconPlus } from './icons.jsx';

/**
 * 信息流（瀑布流两列 / 手机单列）。
 * 加载态、错误态、空态与「载入更多」都在这里收口，避免卡片自己处理分页。
 */
export function Wall({ wall, toast }) {
  const {
    adapter, items, loading, loadingMore, error, cursor,
    empty, popId, load, loadMore, toggleLike, requestReport, patchCommentCount,
  } = wall;

  return (
    <section className="feed" data-od-id="feed">
      <div className="container">
        <div className="wall" id="wall" aria-live="polite" aria-busy={loading}>
          {items.map((post, i) => (
            <PostCard
              key={post.id}
              post={post}
              index={i}
              adapter={adapter}
              toast={toast}
              popping={String(popId) === String(post.id)}
              onLike={toggleLike}
              onReport={requestReport}
              onCommentCount={patchCommentCount}
            />
          ))}
        </div>

        {loading && items.length === 0 && (
          <div className="feed-status">
            <p className="meta">正在加载…</p>
          </div>
        )}

        {error && (
          <div className="feed-status">
            <p className="err">{error}</p>
            <button className="btn btn-secondary" type="button" onClick={load}>
              重试
            </button>
          </div>
        )}

        {empty && !error && (
          <div className="empty">
            <h3>还没有匹配的内容</h3>
            <p>换一个分类或关键词试试，也可以成为第一个发布的人。</p>
          </div>
        )}

        {!loading && !error && cursor && (
          <div className="feed-status">
            <button className="btn btn-secondary" type="button" disabled={loadingMore} onClick={loadMore}>
              <IconPlus />
              {loadingMore ? '加载中…' : '载入更多'}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
