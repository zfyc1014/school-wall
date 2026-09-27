const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** 相对时间：与原型的 rel() 行为逐字一致 */
export function rel(ts) {
  const d = Date.now() - ts;
  if (d < MIN) return '刚刚';
  if (d < HOUR) return `${Math.floor(d / MIN)} 分钟前`;
  if (d < DAY) return `${Math.floor(d / HOUR)} 小时前`;
  if (d < 30 * DAY) return `${Math.floor(d / DAY)} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

/** 点赞数缩写：1284 → 1.3k，2310 → 2.3k，12840 → 13k */
export function nfmt(n) {
  const v = Number(n) || 0;
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 0 : 1).replace(/\.0$/, '')}k`;
  return String(v);
}

export function cx(...parts) {
  return parts.filter(Boolean).join(' ');
}

/** 搜索输入防抖（原型为 160ms） */
export function debounce(fn, wait = 160) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}
