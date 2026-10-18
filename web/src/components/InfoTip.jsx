import { useEffect, useRef, useState } from 'react';

/**
 * 「i」说明。
 *
 * 页面里原来塞了大段 meta 文案（为什么不能改学校、昵称多久冷却……），
 * 新用户看不过来、老用户天天路过也烦。统一收成一个「i」：
 * 需要的时候点一下才展开，不需要就只是一个安静的图标。
 */
export function InfoTip({ children, label = '说明' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDoc);
    return () => document.removeEventListener('pointerdown', onDoc);
  }, [open]);

  if (!children) return null;
  return (
    <span className="info-tip" ref={ref}>
      <button
        type="button"
        className="info-tip-btn"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        i
      </button>
      {open ? <span className="info-tip-pop" role="tooltip">{children}</span> : null}
    </span>
  );
}

export default InfoTip;
