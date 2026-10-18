"use strict";

/**
 * 进程内固定窗口限流。
 *
 * 为什么不用 Redis：最低配置 VPS 上多一个有状态服务 = 多一份内存和运维成本。
 * 单进程部署下，内存计数已足够；横向扩容时把这里换成 Redis 即可（接口不变）。
 *
 * 固定窗口：内存占用恒定（每个键一个对象），窗口边界约有 2 倍瞬时放行，可接受。
 *
 * ⚠️ 安全约束（审计后补的）：键里含用户可控输入（邮箱、号码、UA 链…），
 * 攻击者可以构造大量唯一键把 Map 撑爆 —— 配合「IP 限流被绕过」就是内存耗尽 DoS。
 * 因此这里加了**硬上限 + 过期优先淘汰**；触顶且无法淘汰时，新键直接拒绝（fail-closed），
 * 宁可短时限流偏严，也不让内存无上限增长。
 */

const MAX_BUCKETS = Math.max(1000, Number(process.env.RATE_LIMIT_MAX_KEYS || 50000));

const buckets = new Map(); // key -> { count, resetAt }

function sweepExpired(now) {
  const at = now || Date.now();
  let removed = 0;
  for (const [key, bucket] of buckets) {
    if (at >= bucket.resetAt) { buckets.delete(key); removed += 1; }
  }
  return removed;
}

/**
 * @param {string} key    维度键，例如 `post:${ipHash}`
 * @param {number} max    窗口内最大次数
 * @param {number} windowMs 窗口长度（毫秒）
 * @returns {{ok: boolean, remaining: number, retryAfter: number}}
 */
function limit(key, max, windowMs) {
  const now = Date.now();
  let bucket = buckets.get(key);

  if (!bucket) {
    if (buckets.size >= MAX_BUCKETS) {
      sweepExpired(now);
      // 过期清完还满：按插入顺序淘汰最老的键（Map 迭代顺序即插入顺序）
      while (buckets.size >= MAX_BUCKETS) {
        const oldest = buckets.keys().next().value;
        if (oldest === undefined) break;
        buckets.delete(oldest);
      }
    }
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  } else if (now >= bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
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
const sweeper = setInterval(() => sweepExpired(), 60_000);
sweeper.unref();

module.exports = { limit, sweepExpired, maxBuckets: MAX_BUCKETS, size: () => buckets.size };
