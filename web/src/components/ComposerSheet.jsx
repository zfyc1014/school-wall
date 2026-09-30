import { useEffect, useId, useRef, useState } from 'react';
import { BODY_MAX, BODY_MIN, POST_CATS } from '../lib/types.js';
import { useSheet } from '../hooks/useSheet.js';
import { useGate } from '../context/GateContext.jsx';
import { IconClose, IconHouse, IconShield } from './icons.jsx';

const emptyErrors = { cat: '', body: '', agree: '' };

/**
 * 发布前的内测门禁提示。
 *
 * 内测版不再在抽屉里嵌第三方验证控件：入口闸门已经覆盖了这条路径，
 * 而且数据层在收到 `403 gate_required` 时会自动拉起闸门、验证成功后
 * **重试原来那次提交**（见 data/adapters.js 的 requestWrite）。
 * 这里只负责把这件事说清楚，避免用户以为是「提交失败」。
 */
function ComposerGateNote() {
  const gate = useGate();
  if (!gate.required || gate.verified) return null;

  return (
    <div className="field composer-verify">
      <div className="anon-row">
        <IconShield />
        提交时会先请你输入内测邀请码并答一道题；验证通过后会自动继续提交，不用担心白填。
      </div>
      <p className="meta" style={{ marginTop: 'var(--space-2)' }}>
        <button className="textlink" type="button" onClick={gate.openSheet}>
          现在就去验证
        </button>
      </p>
    </div>
  );
}

/**
 * 发布弹层。校验口径与后端 POST /api/posts 对齐：
 * 分类必须在白名单内，正文 6–500 字，需勾选发布公约。
 * 提交成功后进入审核队列（先审后发），不会立刻出现在墙上。
 */
export function ComposerSheet({ open, onClose, onSubmit }) {
  const [cat, setCat] = useState('');
  const [body, setBody] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [errors, setErrors] = useState(emptyErrors);
  const [sending, setSending] = useState(false);
  const titleId = useId();
  const { ref, entered } = useSheet({ open, onClose });
  const bodyRef = useRef(null);

  // 每次打开都重置表单，避免上次草稿与错误残留
  useEffect(() => {
    if (!open) return;
    setCat('');
    setBody('');
    setAgreed(false);
    setErrors(emptyErrors);
    setSending(false);
  }, [open]);

  async function handleSubmit() {
    const next = { cat: '', body: '', agree: '' };
    if (!cat) next.cat = '请先选择一个分类';
    if (body.trim().length < BODY_MIN) next.body = `正文至少需要 ${BODY_MIN} 个字`;
    if (!agreed) next.agree = '请先阅读并同意发布公约';
    setErrors(next);
    if (next.cat || next.body || next.agree) return;

    setSending(true);
    const ok = await onSubmit({ cat, body: body.trim() });
    setSending(false);
    if (ok) onClose();
  }

  return (
    <div
      className={`modal${entered ? ' open' : ''}`}
      id="composer"
      role="dialog"
      aria-modal="true"
      aria-hidden={!open}
      aria-labelledby={titleId}
    >
      <div className="sheet" ref={ref}>
        <div className="sheet-head">
          <div>
            <h2 id={titleId}>发布一条告白</h2>
            <p className="meta" style={{ marginTop: 4 }}>发出去之前会先人工看一遍</p>
          </div>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="关闭">
            <IconClose />
          </button>
        </div>

        <div className="field">
          <div className="field-label"><span>选择分类</span></div>
          <div className="cat-select" id="cat-select" role="group" aria-label="选择分类">
            {POST_CATS.map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={cat === c}
                onClick={() => {
                  setCat(c);
                  setErrors((prev) => ({ ...prev, cat: '' }));
                }}
              >
                {c}
              </button>
            ))}
          </div>
          {errors.cat && <p className="err">{errors.cat}</p>}
        </div>

        <div className="field">
          <div className="field-label">
            <span>正文</span>
            <span className="meta"><span>{body.length}</span> / {BODY_MAX}</span>
          </div>
          <textarea
            className="textarea"
            ref={bodyRef}
            data-autofocus
            maxLength={BODY_MAX}
            placeholder="写下想说的话。请勿包含真实姓名、联系方式或他人隐私信息。"
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              setErrors((prev) => ({ ...prev, body: '' }));
            }}
          />
          {errors.body && <p className="err">{errors.body}</p>}
        </div>

        <div className="field">
          <div className="anon-row">
            <IconHouse />
            默认以匿名身份发布，前台不展示账号信息
          </div>
        </div>

        <ComposerGateNote />

        <label className="agree">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => {
              setAgreed(e.target.checked);
              setErrors((prev) => ({ ...prev, agree: '' }));
            }}
          />
          <span>
            我已阅读并同意发布公约：不发布人身攻击、诽谤、未经同意披露他人资料（起底）、
            色情或违法内容，并愿意为发布内容承担相应责任。
          </span>
        </label>
        {errors.agree && <p className="err">{errors.agree}</p>}

        <div className="sheet-actions">
          <button className="btn btn-secondary" type="button" onClick={onClose}>取消</button>
          <button
            className="btn btn-primary"
            type="button"
            disabled={sending}
            onClick={handleSubmit}
          >
            {sending ? '提交中…' : '提交审核'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 举报入口：把通知—移除机制做成一条工单（POST /api/reports） */
export function ReportSheet({ open, onClose, onSubmit }) {
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(false);
  const titleId = useId();
  const { ref, entered } = useSheet({ open, onClose });

  useEffect(() => {
    if (open) {
      setReason('');
      setSending(false);
    }
  }, [open]);

  return (
    <div
      className={`modal${entered ? ' open' : ''}`}
      id="report-sheet"
      role="dialog"
      aria-modal="true"
      aria-hidden={!open}
      aria-labelledby={titleId}
    >
      <div className="sheet" ref={ref}>
        <div className="sheet-head">
          <div>
            <h2 id={titleId}>举报这条内容</h2>
            <p className="meta" style={{ marginTop: 4 }}>收到有效举报后将尽快核查</p>
          </div>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="关闭">
            <IconClose />
          </button>
        </div>

        <div className="field">
          <div className="field-label"><span>举报理由（选填）</span></div>
          <textarea
            className="textarea"
            data-autofocus
            maxLength={200}
            style={{ minHeight: 96 }}
            placeholder="例如：包含他人真实姓名与联系方式、人身攻击、疑似诈骗…"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>

        <div className="sheet-actions">
          <button className="btn btn-secondary" type="button" onClick={onClose}>取消</button>
          <button
            className="btn btn-primary"
            type="button"
            disabled={sending}
            onClick={async () => {
              setSending(true);
              const ok = await onSubmit(reason.trim());
              setSending(false);
              if (ok) onClose();
            }}
          >
            {sending ? '提交中…' : '提交举报'}
          </button>
        </div>
      </div>
    </div>
  );
}
