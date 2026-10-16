import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { navigate } from '../router.jsx';
import { Avatar } from '../components/Avatar.jsx';
import { UserBadge } from '../components/UserBadge.jsx';
import { Empty, ErrorState, Loading } from '../components/Empty.jsx';
import { IconBack, IconHeart } from '../components/icons.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { formatDateTime, shortNumber, timeAgo } from '../lib/format.js';

/**
 * 主题详情 + 回复。
 *
 * 底部操作条吸在 dock 上方（position: sticky），而不是 fixed：
 * 帖子短的时候它会自然落在内容末尾，不会在屏幕中间飘一条无主的横条。
 */

/** 与后端 forum.REPLY_MAX 一致：先在前端拦，别等 400 回来才告诉用户 */
const REPLY_MAX = 1000;

export function ThreadPage({ id }) {
  const toast = useToast();
  const { user, requireLogin } = useAuth();

  const [thread, setThread] = useState(null);
  const [replies, setReplies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [replyOpen, setReplyOpen] = useState(false);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [liking, setLiking] = useState(false);
  const inputRef = useRef(null);

  // requireLogin 会在登录**之后**才执行挂起的闭包，那时闭包里的 user 还是点击那一刻的
  // null；回复要立刻插进列表并显示自己的昵称，所以用 ref 取最新值。
  const userRef = useRef(user);
  useEffect(() => { userRef.current = user; }, [user]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.forum.thread(id);
      setThread(data.thread || null);
      setReplies(Array.isArray(data.replies) ? data.replies : []);
    } catch (err) {
      // 404 在这里是常态（帖子被删/被撤），给一句人话而不是「请求失败」
      setError(err.status === 404 ? '帖子不存在或已删除' : (err.message || '加载失败'));
      setThread(null);
      setReplies([]);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // 展开回复框后自动聚焦：用户点「回复」就是要打字，不该再点一次输入框
  useEffect(() => {
    if (replyOpen && inputRef.current) inputRef.current.focus();
  }, [replyOpen]);

  const openAuthor = useCallback((author) => {
    if (!author || !author.uuid) return;
    navigate('/u/' + author.uuid);
  }, []);

  const toggleLike = useCallback(() => {
    requireLogin(async () => {
      if (liking) return;
      setLiking(true);
      try {
        const result = await api.forum.like(id);
        setThread((prev) => (prev ? { ...prev, liked: Boolean(result.liked), likeCount: result.likes } : prev));
      } catch (err) {
        toast(err.message || '操作失败');
      } finally {
        setLiking(false);
      }
    });
  }, [requireLogin, liking, id, toast]);

  const submitReply = useCallback(() => {
    const text = body.trim();
    if (!text || text.length > REPLY_MAX || sending) return;
    requireLogin(async () => {
      setSending(true);
      try {
        const result = await api.forum.reply(id, text);
        if (result.status === 'pending') {
          toast('回复已提交，审核通过后显示');
        } else {
          // 直接插到末尾：不再拉整页，省一次请求也不会把阅读位置顶掉
          setReplies((prev) => prev.concat({
            id: result.id,
            body: text,
            author: userRef.current,
            createdAt: Date.now()
          }));
        }
        setBody('');
        setReplyOpen(false);
      } catch (err) {
        toast(err.message || '回复失败');
      } finally {
        setSending(false);
      }
    });
  }, [body, sending, requireLogin, id, toast]);

  const head = (
    <div className="page-head">
      <button className="btn-icon" type="button" aria-label="返回论坛" onClick={() => navigate('/forum')}>
        <IconBack size={20} />
      </button>
      <h1 className="page-title">帖子</h1>
    </div>
  );

  if (loading) {
    return (
      <div className="container forum-page">
        {head}
        <Loading rows={2} />
      </div>
    );
  }

  if (error || !thread) {
    return (
      <div className="container forum-page">
        {head}
        <ErrorState message={error || '帖子不存在或已删除'} onRetry={load} />
        <button className="btn btn-secondary btn-block" type="button" onClick={() => navigate('/forum')}>
          回到论坛
        </button>
      </div>
    );
  }

  const author = thread.author || null;
  // 详情接口目前只回 excerpt（后端 shapeThreads 组装 thread 时漏了 body，已同步给 LEAD）。
  // 拿不到 body 就退到 excerpt：单段摘要总好过一片空白；后端补上后这里自动用完整正文。
  const bodyText = thread.body || thread.excerpt || '';
  const bodyLen = body.trim().length;
  const canSend = bodyLen >= 1 && bodyLen <= REPLY_MAX;

  return (
    <div className="container forum-page">
      {head}

      <article className="forum-thread-detail card card-pad">
        <h1 className="forum-detail-title">{thread.title}</h1>

        <button
          type="button"
          className="forum-author forum-author-lg"
          onClick={() => openAuthor(author)}
          aria-label={'查看 ' + ((author && author.nickname) || '匿名同学') + ' 的主页'}
        >
          <Avatar user={author} size={40} />
          <span className="forum-author-main">
            <span className="forum-author-name">{(author && author.nickname) || '匿名同学'}</span>
            <UserBadge user={author} variant="full" />
          </span>
        </button>

        <p className="forum-detail-body">{bodyText}</p>

        <div className="forum-detail-meta meta">
          <time title={formatDateTime(thread.createdAt)}>{timeAgo(thread.createdAt)}</time>
          <span aria-hidden="true">·</span>
          <span>{shortNumber(thread.viewCount || 0)} 次浏览</span>
        </div>
      </article>

      <section className="forum-replies" aria-label="回复">
        <h2 className="forum-replies-title">
          全部回复
          <span className="meta">{replies.length}</span>
        </h2>

        {replies.length === 0 ? (
          <Empty title="还没有人回复" hint="说说你的想法" />
        ) : null}

        {replies.map((reply, index) => {
          const replyAuthor = reply.author || null;
          return (
            <article className="forum-reply" key={reply.id}>
              <button
                type="button"
                className="forum-avatar-btn"
                onClick={() => openAuthor(replyAuthor)}
                aria-label={'查看 ' + ((replyAuthor && replyAuthor.nickname) || '匿名同学') + ' 的主页'}
              >
                <Avatar user={replyAuthor} size={32} />
              </button>

              <div className="forum-reply-main">
                <div className="forum-reply-head">
                  <button
                    type="button"
                    className="forum-reply-name"
                    onClick={() => openAuthor(replyAuthor)}
                  >
                    {(replyAuthor && replyAuthor.nickname) || '匿名同学'}
                  </button>
                  <UserBadge user={replyAuthor} variant="title" />
                  <span className="forum-floor">{index + 1} 楼</span>
                </div>

                <p className="forum-reply-body">{reply.body}</p>

                <time className="forum-reply-time meta" title={formatDateTime(reply.createdAt)}>
                  {timeAgo(reply.createdAt)}
                </time>
              </div>
            </article>
          );
        })}
      </section>

      <div className="forum-bar glass" role="group" aria-label="帖子操作">
        {replyOpen ? (
          <div className="forum-bar-form">
            <textarea
              ref={inputRef}
              className="textarea forum-bar-input"
              placeholder={'回复这条帖子（最多 ' + REPLY_MAX + ' 字）'}
              value={body}
              rows={2}
              onChange={(event) => setBody(event.target.value)}
            />
            <div className="forum-bar-actions">
              <span className={'counter' + (bodyLen > REPLY_MAX ? ' is-over' : '')}>{bodyLen}/{REPLY_MAX}</span>
              <button
                className="btn btn-sm"
                type="button"
                onClick={() => { setReplyOpen(false); setBody(''); }}
              >
                收起
              </button>
              <button
                className={'btn btn-sm btn-primary' + (sending ? ' is-loading' : '')}
                type="button"
                disabled={!canSend || sending}
                onClick={submitReply}
              >
                发送
              </button>
            </div>
          </div>
        ) : (
          <button className="forum-reply-open" type="button" onClick={() => setReplyOpen(true)}>
            写下你的回复…
          </button>
        )}

        <button
          className={'forum-like' + (thread.liked ? ' is-liked' : '')}
          type="button"
          disabled={liking}
          aria-pressed={Boolean(thread.liked)}
          aria-label={thread.liked ? '取消点赞' : '点赞'}
          onClick={toggleLike}
        >
          <IconHeart size={22} filled={Boolean(thread.liked)} />
          <span>{Number(thread.likeCount) || 0}</span>
        </button>
      </div>
    </div>
  );
}

export default ThreadPage;
