/** 时间与数字的展示格式（全站统一，避免每个页面各写一套）。 */

/** 相对时间：刚刚 / 12 分钟前 / 3 小时前 / 昨天 / 9月12日 */
export function timeAgo(ts) {
  const t = Number(ts) || 0;
  if (!t) return '';
  const diff = Date.now() - t;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + ' 分钟前';
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + ' 小时前';
  if (diff < 172_800_000) return '昨天';
  if (diff < 2_592_000_000) return Math.floor(diff / 86_400_000) + ' 天前';
  return formatDate(t);
}

export function formatDate(ts) {
  const d = new Date(Number(ts) || 0);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return `${sameYear ? '' : d.getFullYear() + '年'}${d.getMonth() + 1}月${d.getDate()}日`;
}

export function formatDateTime(ts) {
  const d = new Date(Number(ts) || 0);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 聊天气泡用的时分 */
export function formatClock(ts) {
  const d = new Date(Number(ts) || 0);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function plural(n, unit = '') {
  return `${n}${unit}`;
}

/** 数字缩写：1200 → 1.2k */
export function shortNumber(n) {
  const num = Number(n) || 0;
  if (num < 1000) return String(num);
  if (num < 10000) return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return (num / 10000).toFixed(1).replace(/\.0$/, '') + 'w';
}
