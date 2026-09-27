import { useCallback, useId, useState } from 'react';
import { ANON_AVATAR, ANON_NAME, COMMENT_MAX } from '../lib/types.js';
import { rel, nfmt } from '../lib/format.js';
import { useReveal } from '../hooks/useReveal.js';
import { useComments } from '../hooks/useComments.js';
import { IconBubble, IconFlag, IconHeart } from './icons.jsx';

/**
 * 一张墙贴：匿名身份 + 相对时间 + 分类徽标 + 正文 + 点赞/评论/举报。
 * 结构与 class 名与 school-confession-wall.html 的 postCard() 完全一致。
 */
export function PostCard({ post, index, adapter, toast, onLike, onReport, onCommentCount, popping }) {
  const [openComments, setOpenComments] = useState(false);
  const [draft, setDraft] = useState('');
  const reveal = useReveal(Math.min(index * 45, 360));
  const panelId = useId();

  const handleCountChange = useCallback(
    (count) => onCommentCount(post.id, count),
    [onCommentCount, post.id]
  );

  const { comments, state, sending, submit } = useComments({
    open: openComments,
    adapter,
    postId: post.id,
    toast,
    onCountChange: handleCountChange,
  });

  async function handleSubmit(e) {
    e.preventDefault();
    const ok = await submit(draft);
    if (ok) setDraft('');
  }

  return (
    <article
      ref={reveal.ref}
      className={`post reveal ${reveal.className}`}
      style={reveal.style}
      data-od-id={`post-${post.id}`}
    >
      <header className="post-head">
        <span className="avatar" aria-hidden="true">{ANON_AVATAR}</span>
        <div className="post-id">
          <span className="post-name">{ANON_NAME}</span>
          <span className="post-meta meta">{rel(post.createdAt)}</span>
        </div>
        <span className="cat-chip">{post.cat}</span>
      </header>

      <p className="post-body">{post.body}</p>

      <footer className="post-actions">
        <button
          className={`act like${popping ? ' pop' : ''}`}
          type="button"
          aria-pressed={post.liked}
          aria-label={post.liked ? '取消喜欢' : '喜欢'}
          onClick={() => onLike(post.id)}
        >
          <IconHeart />
          <span className="count">{nfmt(post.likes)}</span>
        </button>

        <button
          className="act"
          type="button"
          aria-label="评论"
          aria-expanded={openComments}
          aria-controls={panelId}
          onClick={() => setOpenComments((v) => !v)}
        >
          <IconBubble />
          <span className="count">{post.comments}</span>
        </button>

        <button
          className="act report"
          type="button"
          aria-label="举报"
          onClick={() => onReport(post.id)}
        >
          <IconFlag />
          <span>举报</span>
        </button>
      </footer>

      {openComments && (
        <div className="comments" id={panelId}>
          {state === 'loading' && <p className="meta">正在加载评论…</p>}
          {state === 'error' && <p className="meta">评论加载失败，收起后重试</p>}
          {state === 'ready' && comments.length === 0 && (
            <p className="meta">还没有回复，来说第一句。</p>
          )}
          {state === 'ready' &&
            comments.map((c) => (
              <div className="comment" key={c.id}>
                <span className="who">{c.who}</span>
                <span className="txt">{c.text}</span>
              </div>
            ))}

          <form className="comment-form" onSubmit={handleSubmit}>
            <input
              type="text"
              maxLength={COMMENT_MAX}
              placeholder="匿名回复…"
              aria-label="回复内容"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button type="submit" disabled={sending || !draft.trim()}>
              {sending ? '发送中' : '发送'}
            </button>
          </form>
        </div>
      )}
    </article>
  );
}
