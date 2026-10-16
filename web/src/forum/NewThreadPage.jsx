import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { navigate } from '../router.jsx';
import { IconBack } from '../components/icons.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';

/**
 * 发帖页（整页，不是弹层）。
 *
 * 为什么是整页：标题 + 正文 + 版块三件事在弹层里会被键盘挤成一团，
 * 而发帖是论坛最重的动作，值得一个可以随时返回、内容不会丢的独立页面。
 */

/** 与后端 forum.BOARDS / TITLE_MIN / TITLE_MAX / BODY_MAX 一致 */
const BOARDS = [
  { key: 'general', name: '综合' },
  { key: 'study', name: '学习' },
  { key: 'life', name: '生活' },
  { key: 'lost', name: '失物' }
];
const TITLE_MIN = 2;
const TITLE_MAX = 60;
const BODY_MAX = 4000;

export function NewThreadPage() {
  const toast = useToast();
  const { user, ready, requireLogin } = useAuth();

  const [board, setBoard] = useState('general');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const bodyRef = useRef(null);

  // 长度按 trim 后算：后端也是先归一空白再判长度，前端先算对才不会「看着够长，提交被拒」
  const titleLen = title.trim().length;
  const bodyLen = body.trim().length;
  const titleOk = titleLen >= TITLE_MIN && titleLen <= TITLE_MAX;
  const bodyOk = bodyLen >= 1 && bodyLen <= BODY_MAX;
  const canSubmit = titleOk && bodyOk && !submitting;

  // 正文自动增高：写长帖时不用手动拖拽，也不会在手机上留一大片空白
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.6)) + 'px';
  }, [body]);

  const submit = useCallback(() => {
    if (!canSubmit) return;
    const payload = { board, title: title.trim(), body: body.trim() };
    // 未登录时 requireLogin 会先弹登录，登录成功后自动回来执行这段提交
    requireLogin(async () => {
      setSubmitting(true);
      try {
        const result = await api.forum.createThread(payload);
        if (result.status === 'pending') {
          toast('已提交，审核通过后显示');
          navigate('/forum');
          return;
        }
        toast('已发布');
        navigate('/forum/' + result.id);
      } catch (err) {
        toast(err.message || '发布失败');
      } finally {
        setSubmitting(false);
      }
    });
  }, [canSubmit, board, title, body, requireLogin, toast]);

  return (
    <div className="container forum-page">
      <div className="page-head">
        <button className="btn-icon" type="button" aria-label="返回论坛" onClick={() => navigate('/forum')}>
          <IconBack size={20} />
        </button>
        <h1 className="page-title">发帖</h1>
      </div>

      <div className="stack-lg forum-form">
        <label className="field">
          <span className="field-label">版块</span>
          <select className="select" value={board} onChange={(event) => setBoard(event.target.value)}>
            {BOARDS.map((item) => (
              <option key={item.key} value={item.key}>{item.name}</option>
            ))}
          </select>
        </label>

        <label className="field">
          <span className="field-label">标题</span>
          <input
            className="input"
            value={title}
            placeholder="一句话说清你想聊什么"
            aria-describedby="forum-title-counter"
            onChange={(event) => setTitle(event.target.value)}
          />
          <span
            id="forum-title-counter"
            className={'counter' + (titleLen > TITLE_MAX ? ' is-over' : '')}
          >
            {titleLen}/{TITLE_MAX}
          </span>
        </label>

        <label className="field">
          <span className="field-label">正文</span>
          <textarea
            ref={bodyRef}
            className="textarea"
            value={body}
            placeholder={'把话说清楚：发生了什么、想问什么（最多 ' + BODY_MAX + ' 字）'}
            aria-describedby="forum-body-counter"
            onChange={(event) => setBody(event.target.value)}
          />
          <span
            id="forum-body-counter"
            className={'counter' + (bodyLen > BODY_MAX ? ' is-over' : '')}
          >
            {bodyLen}/{BODY_MAX}
          </span>
        </label>

        {/* 不用 <form>：标题里按回车就发出去太容易误触，发布必须是一次明确的点击 */}
        <button
          className={'btn btn-primary btn-block' + (submitting ? ' is-loading' : '')}
          type="button"
          disabled={!canSubmit}
          onClick={submit}
        >
          发布
        </button>

        <p className="meta forum-form-note">
          {ready && !user ? '发布需要先登录，点上面的按钮会先请你登录。' : '发布后默认直接公开；命中预筛的帖子会先进入人工审核。'}
        </p>
      </div>
    </div>
  );
}

export default NewThreadPage;
