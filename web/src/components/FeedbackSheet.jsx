import { useEffect, useId, useState } from 'react';
import { useSheet } from '../hooks/useSheet.js';
import { FEEDBACK_CATS } from '../lib/beta.js';
import { IconBubble, IconClose } from './icons.jsx';

/**
 * 内测反馈弹层。
 *
 * 与举报弹层的差别（以及为什么不是一个东西）：
 *   - 举报针对「某条内容」，会生成工单并可能触发下架；
 *   - 反馈针对「产品本身」，只进后台的反馈队列，不影响任何公开内容。
 *
 * 联系方式是选填的：不留也能提交 —— 为了收反馈而强制收集个人信息不划算。
 */
export function FeedbackSheet({ open, onClose, onSubmit, beta }) {
  const [cat, setCat] = useState('bug');
  const [body, setBody] = useState('');
  const [contact, setContact] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const titleId = useId();
  const { ref, entered } = useSheet({ open, onClose });
  const max = Number(beta?.feedbackMax) || 800;

  // 每次打开重置：避免上次草稿与错误残留
  useEffect(() => {
    if (!open) return;
    setCat('bug');
    setBody('');
    setContact('');
    setSending(false);
    setError('');
  }, [open]);

  async function handleSubmit() {
    const text = body.trim();
    if (text.length < 4) {
      setError('请至少写 4 个字，方便我们复现问题');
      return;
    }
    setSending(true);
    setError('');
    const ok = await onSubmit({ cat, body: text, contact: contact.trim() });
    setSending(false);
    if (ok) onClose();
  }

  return (
    <div
      className={`modal${entered ? ' open' : ''}`}
      id="feedback"
      role="dialog"
      aria-modal="true"
      aria-hidden={!open}
      aria-labelledby={titleId}
    >
      <div className="sheet" ref={ref}>
        <div className="sheet-head">
          <div>
            <h2 id={titleId}>内测反馈</h2>
            <p className="meta" style={{ marginTop: 4 }}>
              问题、建议、看不懂的地方都欢迎 —— 只有运营能看到。
            </p>
          </div>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="关闭">
            <IconClose />
          </button>
        </div>

        <div className="field">
          <div className="field-label"><span>反馈类型</span></div>
          <div className="cat-select" role="group" aria-label="反馈类型">
            {FEEDBACK_CATS.map((item) => (
              <button
                key={item.key}
                type="button"
                aria-pressed={cat === item.key}
                onClick={() => setCat(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <div className="field-label">
            <span>具体内容</span>
            <span className="meta"><span>{body.length}</span> / {max}</span>
          </div>
          <textarea
            className="textarea"
            data-autofocus
            data-feedback-body
            maxLength={max}
            placeholder="例如：在 iPhone 上点「载入更多」后卡片会闪一下；建议把分类顺序改成…"
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              setError('');
            }}
          />
        </div>

        <div className="field">
          <div className="field-label">
            <span>联系方式（选填）</span>
            <span className="meta">留了才能回复你</span>
          </div>
          <input
            className="text-input"
            type="text"
            autoComplete="off"
            maxLength={120}
            placeholder="邮箱 / 微信号 / 其它能找到你的方式"
            value={contact}
            onChange={(e) => setContact(e.target.value)}
          />
        </div>

        {error && <p className="err">{error}</p>}

        <p className="stamp">
          反馈会带上提交时间与不可逆的网络哈希（用于防刷），不保存原始 IP；
          {beta?.feedbackEmail ? ` 也可以直接发邮件到 ${beta.feedbackEmail}。` : ''}
        </p>

        <div className="sheet-actions">
          <button className="btn btn-secondary" type="button" onClick={onClose}>取消</button>
          <button
            className="btn btn-primary"
            type="button"
            data-feedback-submit
            disabled={sending}
            onClick={handleSubmit}
          >
            <IconBubble width={15} height={15} />
            {sending ? '提交中…' : '提交反馈'}
          </button>
        </div>
      </div>
    </div>
  );
}
