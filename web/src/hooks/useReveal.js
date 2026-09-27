import { useEffect, useState } from 'react';

/** 进入视口后加 .in，触发一次性的入场动画（与原型 IntersectionObserver 一致） */
export function useReveal(delay = 0) {
  const [node, setNode] = useState(/** @type {HTMLElement|null} */ (null));
  const [inView, setInView] = useState(false);

  useEffect(() => {
    if (!node || inView) return undefined;
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return undefined;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setInView(true);
            io.unobserve(entry.target);
          }
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.05 }
    );
    io.observe(node);
    return () => io.disconnect();
  }, [node, inView]);

  const className = inView ? 'in' : '';
  const style = delay ? { transitionDelay: `${delay}ms` } : undefined;
  return { ref: setNode, className, style, inView };
}
