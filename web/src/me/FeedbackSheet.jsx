import { useState } from 'react';
import { api } from '../api/client.js';
import { useToast } from '../context/ToastContext.jsx';
import { Sheet } from '../components/Sheet.jsx';

/** 意见反馈（登录与否都能提交；登录后会带上账号便于回访）。 */
export function FeedbackSheet({ open, onClose }) {
  const toast = useToast();
  const [cat, setCat] = useState('idea');
  const [body, setBody] = useState('');
  const [contact, setContact] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const text = body.trim();
    if (text.length < 4) {
      toast('再多写几个字吧');
      return;
    }
    setBusy(true);
    try {
      await api.feedback({ cat, body: text, contact: contact.trim() });
      toast('收到，谢谢你的反馈');
      setBody('');
      setContact('');
      onClose && onClose();
    } catch (err) {
      toast(err.message || '提交失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="意见反馈"
      footer={(
        <>
          <button className="btn btn-secondary" type="button" onClick={onClose}>取消</button>
          <button className="btn btn-primary" type="button" disabled={busy} onClick={submit}>
            {busy ? '提交中…' : '提交'}
          </button>
        </>
      )}
    >
      <div className="stack-lg">
        <div className="field">
          <label className="field-label" htmlFor="fb-cat">类型</label>
          <div className="chips" id="fb-cat">
            {[['bug', '遇到问题'], ['idea', '有个想法'], ['other', '其它']].map(([key, label]) => (
              <button
                key={key}
                className="chip"
                type="button"
                aria-pressed={cat === key}
                onClick={() => setCat(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="fb-body">内容</label>
          <textarea
            id="fb-body"
            className="textarea"
            style={{ minHeight: 120 }}
            maxLength={800}
            placeholder="说说遇到了什么，或者你希望有什么功能"
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="fb-contact">联系方式（选填）</label>
          <input
            id="fb-contact"
            className="input"
            placeholder="邮箱或其它能找到你的方式"
            value={contact}
            onChange={(event) => setContact(event.target.value)}
          />
        </div>
      </div>
    </Sheet>
  );
}

export default FeedbackSheet;
