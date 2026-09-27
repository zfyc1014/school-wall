import { useEffect, useRef, useState } from 'react';

const LOCK_CLASS = 'od-scroll-lock';

/** 弹层打开时锁住背景滚动，关闭或卸载时精确还原 */
function lockScroll() {
  const { body } = document;
  const scrollbar = window.innerWidth - document.documentElement.clientWidth;
  const prevOverflow = body.style.overflow;
  const prevPadding = body.style.paddingRight;
  body.style.overflow = 'hidden';
  if (scrollbar > 0) body.style.paddingRight = `${scrollbar}px`;
  body.classList.add(LOCK_CLASS);
  return () => {
    body.style.overflow = prevOverflow;
    body.style.paddingRight = prevPadding;
    body.classList.remove(LOCK_CLASS);
  };
}

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * 弹层行为：挂载后淡入（保留原型的 transition）、Esc 关闭、
 * 焦点陷阱、关闭后把焦点还给触发元素。
 *
 * @param {{ open: boolean, onClose: () => void, lock?: boolean }} options
 * @returns {{ ref: React.RefObject<HTMLElement>, visible: boolean, entered: boolean, close: () => void }}
 *   visible —— 是否保留在 DOM 中（覆盖淡入 + 淡出全过程）
 *   entered —— 是否已加上 .open（淡入由一个 requestAnimationFrame 触发 transition）
 */
export function useSheet({ open, onClose, lock = true }) {
  const ref = useRef(/** @type {HTMLElement|null} */ (null));
  const [mounted, setMounted] = useState(open);
  const [entered, setEntered] = useState(false);
  const restoreFocus = useRef(/** @type {HTMLElement|null} */ (null));

  // 关闭后延迟卸载，等淡出动画结束（220ms）
  useEffect(() => {
    if (open) {
      setMounted(true);
      const raf = requestAnimationFrame(() => setEntered(true));
      return () => cancelAnimationFrame(raf);
    }
    setEntered(false);
    const timer = setTimeout(() => setMounted(false), 240);
    return () => clearTimeout(timer);
  }, [open]);

  // 滚动锁 + 初始焦点 + 焦点归还
  // 焦点不依赖 setTimeout：requestAnimationFrame 两帧后节点必然已挂载并加上 .open。
  // 若打开后 400ms 仍没落位（例如被浏览器/DevTools 抢走），再补一次。
  useEffect(() => {
    if (!open) return undefined;
    restoreFocus.current = document.activeElement;
    const unlock = lock ? lockScroll() : () => {};

    let raf1 = 0;
    let raf2 = 0;
    let retry = 0;
    const focusTarget = () => {
      const node = ref.current;
      if (!node) return false;
      const target = node.querySelector('[data-autofocus]') || node.querySelector(FOCUSABLE);
      if (!target || typeof target.focus !== 'function') return false;
      target.focus();
      return document.activeElement === target;
    };
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        if (!focusTarget()) {
          retry = setTimeout(focusTarget, 120);
        }
      });
    });

    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      clearTimeout(retry);
      unlock();
      const back = restoreFocus.current;
      if (back && typeof back.focus === 'function') back.focus();
    };
  }, [open, lock]);

  // Esc 关闭 + Tab 循环
  useEffect(() => {
    if (!open) return undefined;
    function onKeyDown(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const node = ref.current;
      if (!node) return;
      const items = Array.from(node.querySelectorAll(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement
      );
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, onClose]);

  return { ref, visible: mounted, entered, close: onClose };
}

export { FOCUSABLE };
