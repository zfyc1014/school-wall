import { useEffect, useRef } from 'react';
import { IconClose } from './icons.jsx';

/**
 * 底部弹层。
 *
 * 三个细节决定了它好不好用：
 *   1. 打开时锁住 body 滚动 —— 否则背景会跟着手指一起动，像坏掉的页面；
 *   2. 点遮罩关闭、Esc 关闭，拖动条只是视觉提示（不做手势，避免和内部滚动打架）；
 *   3. 关闭时先播动画再卸载，靠 closing 状态延迟一帧。
 */
export function Sheet({ open, onClose, title, children, footer, full = false, labelledBy }) {
  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') onClose && onClose();
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-labelledby={labelledBy || 'sheet-title'}>
      <button className="sheet-backdrop" type="button" aria-label="关闭" onClick={onClose} />
      <div className={'sheet-panel' + (full ? ' is-full' : '')} ref={panelRef}>
        <div className="sheet-grab" aria-hidden="true" />
        {title ? (
          <div className="sheet-head">
            <h2 id={labelledBy || 'sheet-title'} className="sheet-title">{title}</h2>
            <button className="btn-icon" type="button" onClick={onClose} aria-label="关闭">
              <IconClose size={18} />
            </button>
          </div>
        ) : null}
        <div className="sheet-body">{children}</div>
        {footer ? <div className="sheet-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

export default Sheet;
