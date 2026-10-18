import { useEffect, useState } from 'react';
import { Sheet } from './Sheet.jsx';

/**
 * 版本更新提示。
 *
 * 规则很朴素：localStorage 记住「上次看到的版本号」，与当前版本不同就弹一次。
 * 文案刻意口语化 —— 用户不关心「重构了审核链路」，只关心「加载不白屏了、发帖不用等审核了」。
 */
const NOTES = {
  '1.0.1': [
    '打开页面先看到一个会跳的「校园墙」，不再白屏干等',
    '首页变成一整块可以自己写的页面（站方能在后台改）',
    '发帖/评论过了违禁词就直接上墙，不用再等审核',
    '「我的」里能直接联系作者，还加了开发者与感谢名单',
    '顺手做了高刷屏优化，滑动更跟手'
  ]
};

const STORAGE_KEY = 'od_seen_version';

export function WhatsNew({ version }) {
  const [open, setOpen] = useState(false);
  const notes = IMPORTANT[version] || NOTES[version] || null;

  useEffect(() => {
    if (!version || !notes) return;
    let seen = '';
    try { seen = localStorage.getItem(STORAGE_KEY) || ''; } catch { /* 隐私模式 */ }
    if (seen === version) return;
    setOpen(true);
  }, [version, notes]);

  const close = () => {
    try { localStorage.setItem(STORAGE_KEY, version); } catch { /* ignore */ }
    setOpen(false);
  };

  const list = (NOTES[version] || []).length ? NOTES[version] : (IMPORTANT[version] || []);
  if (!notes || !open) return null;

  return (
    <Sheet open={open} onClose={close} title={'更新到 v' + version}>
      <div className="stack-lg">
        <p className="meta">这次改了点东西，都在下面，一眼看完。</p>
        <ul className="whatsnew-list">
          {list.map((line) => <li key={line}>{line}</li>)}
        </ul>
        <button className="btn btn-primary btn-block" type="button" onClick={close}>知道了</button>
      </div>
    </Sheet>
  );
}

/** 必须在弹窗里出现的关键公告（按版本号；没有就走 NOTES） */
const IMPORTANT = {};

export default WhatsNew;
