"use strict";

/**
 * 进程内固定窗口限流。
 *
 * 为什么不用 Redis：最低配置 VPS 上多一个有状态服务 = 多一份内存和运维成本。
 * 单进程部署下，内存计数已足够；横向扩容时把这里换成 Redis 即可（接口不变）。
 *
 * 采用固定窗口而非滑动窗口：内存占用恒定（每个键一个对象），
 * 代价是窗口边界处可能出现约 2 倍瞬时放行，对本场景可接受。
 */

const buckets = new Map(); // key -> { count, resetAt }

/**
 * @param {string} key    维度键，例如 `post:${ipHash}`
 * @param {number} max    窗口内最大次数
 * @param {number} windowMs 窗口长度（毫秒）
 * @returns {{ok: boolean, remaining: number, retryAfter: number}}
 */
function limit(key, max, windowMs) {
  const now = Date.now();
  let bucket = buckets.get(key);

  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }

  bucket.count += 1;
  const ok = bucket.count <= max;

  return {
    ok,
    remaining: Math.max(0, max - bucket.count),
    retryAfter: ok ? 0 : Math.ceil((bucket.resetAt - now) / 1000)
  };
}

// 定期清理过期键，避免内存随 IP 数无限增长
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now >= bucket.resetAt) buckets.delete(key);
  }
}, 60_000);
sweeper.unref();

module.exports = { limit, size: () => buckets.size };
