/** localStorage 键名：v2 沿用 v1 前缀，便于识别是同一产品的本地数据 */
export const STORE_KEY = 'od_biaobai_v2';
export const LIKES_KEY = 'od_biaobai_likes_v1';
export const MODE_KEY = 'od_biaobai_mode_v1';

/** 隐私模式 / 禁用存储时全部降级为内存，绝不抛错打断渲染 */
function safeGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function readJSON(key, fallback) {
  const raw = safeGet(key);
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeJSON(key, value) {
  return safeSet(key, JSON.stringify(value));
}

/**
 * 本地点赞记录：后端只返回计数，不返回「我是否点过」，
 * 因此点赞态由前端按帖子 id 记住，避免刷新后心形回弹误导用户。
 * @returns {Set<string>}
 */
export function loadLikedIds() {
  const arr = readJSON(LIKES_KEY, []);
  return new Set(Array.isArray(arr) ? arr.map(String) : []);
}

export function saveLikedIds(set) {
  writeJSON(LIKES_KEY, Array.from(set));
}
