import { useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { timeAgo } from '../lib/format.js';
import { IconComment, IconHeart, IconMore } from './icons.jsx';

/**
 * 表白墙卡片。
 *
 * 匿名是产品前提：卡片上**不出现任何作者信息**，只有内容、分类、点赞与评论。
 * 长文默认折叠到 8 行，点「展开」看全文（取消字数上限之后必须处理这件事，
 * 否则一条几千字的帖子会把整个信息流顶穿）。
 */
export function PostCard({ post, liked, onLike, onComment, onReport }) {
  const { requireLogin } = useAuth();
  const toast = useToast();
  const [expanded, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [comments, setComments] = useState(null);
  const [commentText, setCommentText] = useState('');
  const [sending, setSending] = useState(false);

  const body = String(post.body || '');
  const isLong = body.length > 220;

  const loadComments = async () => {
    setComments((prev) => (prev ? prev : []));
    try {
      const data = await api.posts.comments(post.id);
      setComments(Array.isArray(data.items) ? data.items : []);
    } catch (err) {
      toast(err.message || '评论加载失败');
    }
  };

  const submitComment = async () => {
    const text = commentText.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const result = await api.posts.comment(post.id, text);
      setCommentText('');
      toast(result.status === 'pending' ? '评论已提交，审核通过后显示' : '已发布');
    } catch (err) {
      toast(err.message || '评论失败');
    } finally {
      setSending(false);
    }
  };

  return (
    <article className="post">
      <header className="post-head">
        <span className="tag">{post.cat}</span>
        <span className="meta">{timeAgo(post.createdAt)}</span>
        <div className="grow" />
        <div className="post-menu">
          <button
            className="btn-icon"
            type="button"
            aria-label="更多"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <IconMore size={18} />
          </button>
          {menuOpen ? (
            <div className="post-menu-pop glass glass-strong">
              <button
                type="button"
                className="list-item"
                onClick={() => { setMenuOpen(false); onReport(post); }}
              >
                举报
              </button>
            </div>
          ) : null}
        </div>
      </header>

      <p className={'post-body' + (isLong && !expanded ? ' is-clamped' : '')}>{body}</p>
      {isLong ? (
        <button className="post-more" type="button" onClick={() => setExpanded((v) => !v)}>
          {expanded ? '收起' : '展开全文'}
        </button>
      ) : null}

      <footer className="post-actions">
        <button
          className={'post-action' + (liked ? ' is-liked' : '')}
          type="button"
          aria-pressed={liked}
          onClick={() => onLike(post)}
        >
          <IconHeart size={19} filled={liked} />
          <span>{post.likes || 0}</span>
        </button>
        <button
          className="post-action"
          type="button"
          onClick={() => {
            requireLogin(() => {
              if (comments === null) loadComments();
              else setComments(null);
              onComment(post);
            });
          }}
        >
          <IconComment size={19} />
          <span>{post.comments || 0}</span>
        </button>
      </footer>

      {comments !== null ? (
        <section className="post-comments">
          {comments.length === 0 ? <p className="meta">还没有评论</p> : null}
          {comments.map((item) => (
            <p key={item.id} className="post-comment">
              <span className="post-comment-body">{item.body}</span>
              <span className="meta">{timeAgo(item.createdAt)}</span>
            </p>
          ))}
          <div className="post-comment-form">
            <input
              className="input"
              placeholder="说点什么…"
              value={commentText}
              maxLength={300}
              onChange={(event) => setCommentText(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') submitComment(); }}
            />
            <button className="btn btn-primary btn-sm" type="button" disabled={sending || !commentText.trim()} onClick={submitComment}>
              发送
            </button>
          </div>
        </section>
      ) : null}
    </article>
  );
}

export default PostCard;
