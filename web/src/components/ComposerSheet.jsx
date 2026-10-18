import { useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { Sheet } from './Sheet.jsx';
import { CATS } from '../pages/Wall.jsx';

/**
 * 发布表白。
 *
 * 「取消表白字数限制」是明确的产品要求，所以这里**没有字数上限、也没有计数器**；
 * 唯一的下限是非空。真正的边界是服务端的请求体上限（MAX_BODY）。
 * 分类保留 —— 它是首页筛选的基础，去掉的话信息流就没法按需收窄。
 */
export function ComposerSheet({ open, onClose, onPublished }) {
  const { user, openAuth } = useAuth();
  const toast = useToast();
  const [cat, setCat] = useState('表白');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const text = body.trim();
    if (!text) {
      toast('写点什么再发吧');
      return;
    }
    setBusy(true);
    try {
      const result = await api.posts.create({ cat, body: text });
      toast(result.status === 'pending' ? '已提交，审核通过后公开' : '已发布');
      setBody('');
      onPublished && onPublished();
      onClose && onClose();
    } catch (err) {
      toast(err.message || '发布失败');
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  // 未登录时不弹编辑器，直接引导登录：先写后登录会丢掉刚写的内容
  if (!user) {
    return (
      <Sheet open={open} onClose={onClose} title="发布表白">
        <p className="muted">登录后才能发布。用邮箱验证码登录，不需要密码。</p>
        <div style={{ marginTop: 20 }}>
          <button className="btn btn-primary btn-block" type="button" onClick={() => { onClose && onClose(); openAuth(); }}>
            去登录
          </button>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="发布表白"
      footer={(
        <>
          <button className="btn btn-secondary" type="button" onClick={onClose}>取消</button>
          <button className="btn btn-primary" type="button" disabled={busy || !body.trim()} onClick={submit}>
            {busy ? '发布中…' : '发布'}
          </button>
        </>
      )}
    >
      <div className="stack-lg">
        <div className="field">
          <label className="field-label" htmlFor="composer-cat">分类</label>
          <div className="chips" id="composer-cat">
            {CATS.filter((item) => item !== '全部').map((item) => (
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
        </div>

        <div className="field">
          <label className="field-label" htmlFor="composer-body">内容</label>
          <textarea
            id="composer-body"
            className="textarea"
            placeholder="想说什么就写什么，发出去是匿名的"
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
          <p className="meta">发布后会先进审核，通过后才出现在墙上；不会显示你的昵称。</p>
        </div>
      </div>
    </Sheet>
  );
}

export default ComposerSheet;
