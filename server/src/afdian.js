"use strict";

/**
 * 爱发电（赞助）接入。
 *
 * 开发者页：https://afdian.com/dashboard/dev
 * 接口基址：https://afdian.com/api/open
 *
 * 签名算法（与官方 Node SDK 逐字一致）：
 *   md5(token + "params" + params + "ts" + ts + "user_id" + user_id)
 * 注意 `params` 参与签名的是**序列化后的 JSON 字符串本身**，不是对象 ——
 * 这一点最容易写错：拿对象去拼字符串会得到一个永远对不上的签名。
 *
 * 两条链路：
 *   1. **回调（主）**：爱发电在订单支付后 POST 到 /api/afdian/webhook，
 *      body 是 form-urlencoded：`params=<外层JSON>&sign=<md5>`，
 *      其中外层 JSON 形如 {user_id, params: "<内层事件JSON>", ts, sign}。
 *      必须回 `{"ec":200,"em":""}`，否则平台会按自己的节奏重试。
 *   2. **查询（辅）**：POST /api/open/query-order 与 query-sponsor，
 *      用于「回调漏了，手动补单」与对账。
 *
 * 幂等：out_trade_no 唯一。爱发电的重试、以及手动补单，都不会重复发奖。
 */

const crypto = require("crypto");
const db = require("./db");
const config = require("./config");
const users = require("./users");
const { classifyNickname } = require("./moderation");

const RECENT_MAX = 20;
/** 最近若干次回调尝试（含被拒的），供后台排查「为什么没到账」 */
const recentAttempts = [];

function rememberAttempt(entry) {
  recentAttempts.unshift(Object.assign({ at: Date.now() }, entry));
  if (recentAttempts.length > RECENT_MAX) recentAttempts.length = RECENT_MAX;
}

/* ───────────────────────────── 签名 ───────────────────────────── */

/** 参与签名的原串：顺序固定，`params` 是字符串本身 */
function signSource({ token, params, ts, userId }) {
  return `${token}params${params}ts${ts}user_id${userId}`;
}

function md5(text) {
  return crypto.createHash("md5").update(String(text), "utf8").digest("hex");
}

/** 生成签名（服务端主动请求爱发电接口时用） */
function sign({ params, ts, userId } = {}) {
  return md5(signSource({
    token: config.AFDIAN.token,
    params,
    ts,
    userId: userId || config.AFDIAN.userId
  }));
}

/** 定长比较，避免用 === 比哈希带来时序侧信道 */
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ""), "utf8");
  const y = Buffer.from(String(b || ""), "utf8");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* ─────────────────────── 回调解析与校验 ─────────────────────── */

/**
 * 解析回调 body。刻意做得宽容：不同时期/不同接入方式下，
 * 爱发电可能发 form-urlencoded 也可能发 JSON，这里两种都认，
 * 认不出来就把原文记进 recentAttempts，方便运维一眼看出真实格式。
 *
 * @returns {{ok: boolean, reason?: string, envelope?: object, event?: object}}
 */
function parseWebhook(rawBody, contentType) {
  const raw = String(rawBody || "");
  const type = String(contentType || "");

  let envelope = null;

  if (type.includes("application/json") || raw.trim().startsWith("{")) {
    try {
      envelope = JSON.parse(raw);
    } catch {
      return { ok: false, reason: "invalid_json" };
    }
  } else {
    // form-urlencoded：params=<外层JSON>&sign=<md5>
    const form = new URLSearchParams(raw);
    const params = form.get("params");
    if (!params) return { ok: false, reason: "missing_params" };
    try {
      envelope = JSON.parse(params);
    } catch {
      return { ok: false, reason: "invalid_params_json" };
    }
    // 表单里的 sign 优先（它才是校验目标）
    if (form.get("sign")) envelope.sign = form.get("sign");
  }

  if (!envelope || typeof envelope !== "object") return { ok: false, reason: "invalid_envelope" };

  // 已经是「事件体」的情况（没有外层信封）：{ec, em, data:{type, order}}
  if (envelope.data && envelope.data.type) {
    return { ok: false, reason: "unsigned_event", envelope };
  }

  const { user_id: userId, params, ts, sign: got } = envelope;
  if (!params || !ts || !userId) return { ok: false, reason: "incomplete_envelope", envelope };

  if (!config.AFDIAN.token) return { ok: false, reason: "token_not_configured", envelope };

  const expected = md5(signSource({ token: config.AFDIAN.token, params, ts, userId }));
  if (!got) return { ok: false, reason: "missing_sign", envelope };
  if (!safeEqual(expected, got)) return { ok: false, reason: "bad_sign", envelope };

  let event = null;
  try {
    event = JSON.parse(params);
  } catch {
    return { ok: false, reason: "invalid_event_json", envelope };
  }

  return { ok: true, envelope, event };
}

/* ───────────────────────────── 订单入库 ───────────────────────────── */

/** 爱发电的时间戳是「秒」，本站统一用毫秒；两种都兼容 */
function toMillis(value) {
  const n = Number(value) || 0;
  if (!n) return Date.now();
  return n < 1e12 ? n * 1000 : n;
}

function normalizeOrder(order) {
  return {
    outTradeNo: String(order.out_trade_no || "").trim(),
    afdianUser: String(order.user_id || "").trim(),
    planId: String(order.plan_id || "").trim(),
    amount: String(order.total_amount != null ? order.total_amount : (order.show_amount != null ? order.show_amount : "")),
    months: Number(order.month) || 0,
    status: Number(order.status) || 0,
    remark: String(order.remark || "").trim().slice(0, 200),
    createdAt: toMillis(order.created_at || order.time)
  };
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

/**
 * 用下单留言匹配本站账号。
 *
 * 为什么用留言：爱发电的订单不带付款人邮箱，唯一能把「爱发电的这单」和
 * 「本站的这个人」连起来的，只有用户自己填的留言。因此给用户的引导是
 * 「下单时在留言里填你的 uuid 或注册邮箱」，两种都认。
 */
function matchUser(remark) {
  const text = String(remark || "");
  if (!text) return null;
  const uuid = text.match(UUID_RE);
  if (uuid) {
    const user = users.findByUuid(uuid[0]);
    if (user) return { user, via: "remark_uuid" };
  }
  const email = text.match(EMAIL_RE);
  if (email) {
    const user = users.findByEmail(email[0]);
    if (user) return { user, via: "remark_email" };
  }
  return null;
}

/** 金额（字符串）→ 分，避免浮点比较出岔子 */
function centsOf(amount) {
  return Math.max(0, Math.round((Number(amount) || 0) * 100));
}

/** 取「不超过该金额的最高档位」 */
function pickTier(cents, tiers) {
  let hit = null;
  for (const tier of tiers) {
    if (tier.cents <= cents) hit = tier;
  }
  return hit;
}

/** 取「不超过该金额的最高**固定**档位」—— 自定义头衔不可用时的回落目标 */
function pickFixedTier(cents, tiers) {
  let hit = null;
  for (const tier of tiers) {
    if (tier.title !== "@custom" && tier.cents <= cents) hit = tier;
  }
  return hit;
}

/**
 * 从留言里抠出自定义头衔。
 *
 * 留言同时承担两件事（匹配账号 + 指定头衔），所以用一个关键词来分隔：
 *   `我的标识：<uuid>` / `头衔：夜跑的阿哲`
 * 关键词可通过 AFDIAN_CUSTOM_KEYWORD 改（默认「头衔」，同时接受「称号」「title」）。
 * 只取第一段连续的非空白文本，长度交给后面统一校验。
 */
function extractCustomTitle(remark) {
  const text = String(remark || "");
  if (!text) return "";
  const keywords = [config.AFDIAN.customKeyword, "称号", "title"].filter(Boolean);
  for (const keyword of keywords) {
    const re = new RegExp(keyword + "\\s*[:：]?\\s*([^\\s，,。;；、\\n]{1,24})", "i");
    const m = text.match(re);
    if (m && m[1]) return m[1].trim();
  }
  return "";
}

/** 找到（必要时创建）赞助者头衔 */
function ensureRewardTitle(name) {
  const wanted = String(name || "").trim();
  if (!wanted) return null;
  const existing = users.allTitles().find((t) => t.name === wanted);
  if (existing) return existing;
  const created = users.createTitle({ name: wanted, color: "#ff9f0a", minLevel: 1, auto: false, sort: 100 });
  if (!created.ok) {
    // 并发创建时可能撞名：再查一次即可
    return users.allTitles().find((t) => t.name === wanted) || null;
  }
  return users.allTitles().find((t) => t.id === created.id) || null;
}

/**
 * 判断能不能用赞助头衔覆盖用户当前的头衔。
 *
 * 规则：**赞助头衔可以被更高的档位覆盖，管理员手动指派的不能被覆盖**。
 * 靠 `afdian_orders.title_id` 判断「当前这个头衔是不是赞助发的」——
 * 这样 5 元拿到「股东」的人后来又发电 10 元，能顺利升级成自定义头衔，
 * 而「版主」这类人工身份不会被一笔赞助顶掉。
 */
function canReplaceTitle(user, titleId) {
  const fresh = users.findById(user.id);
  if (!fresh || !fresh.title_id) return true;
  if (fresh.title_id === titleId) return true;
  const granted = db.prepare(
    "SELECT 1 AS hit FROM afdian_orders WHERE user_id = ? AND title_id = ? LIMIT 1"
  ).get(user.id, fresh.title_id);
  return Boolean(granted);
}

/**
 * 按金额分档发奖（全自动，无需审批）。
 *
 * 档位表默认 `5:股东;10:@custom`：
 *   - 发电 ≥5 元 → 固定头衔「股东」
 *   - 发电 ≥10 元 → 留言里自定义的头衔（`头衔：xxx`）
 *   - 自定义头衔不可用（没写/含违禁词/冒名官方）→ 回落到该金额以下的最高固定档
 *   - 连固定档都没有（金额低于最低档）→ 只记录不发奖
 *
 * @returns {{text: string, titleId: number|null}} text 写进订单 reward 列便于追溯
 */
function grantReward(user, order) {
  const notes = [];
  let grantedTitleId = null;
  const cents = centsOf(order.amount);
  const tiers = config.AFDIAN.tiers;

  if (tiers.length) {
    const tier = pickTier(cents, tiers);
    if (!tier) {
      const min = tiers[0].cents / 100;
      notes.push(`金额 ${(cents / 100).toFixed(2)} 元未达到发奖档位（最低 ${min} 元）`);
    } else {
      let wanted = tier.title;
      let why = "";
      if (wanted === "@custom") {
        const custom = extractCustomTitle(order.remark);
        if (!custom) {
          const fallback = pickFixedTier(cents, tiers);
          wanted = fallback ? fallback.title : "";
          why = "留言里没写自定义头衔";
        } else {
          // 头衔会挂在这个人主页上，必须过一遍和昵称同样的预审：
          // 违禁词、联系方式、冒名官方（否则花 10 元就能叫「管理员」）
          const verdict = classifyNickname(custom);
          if (verdict.rejected) {
            const fallback = pickFixedTier(cents, tiers);
            wanted = fallback ? fallback.title : "";
            why = `自定义头衔「${custom}」不可用（${verdict.flags.join("/")}）`;
          } else {
            wanted = custom;
          }
        }
      }

      if (!wanted) {
        notes.push(why || "没有可发放的头衔");
      } else {
        const title = ensureRewardTitle(wanted);
        if (!title) {
          notes.push(`头衔「${wanted}」创建失败`);
        } else if (canReplaceTitle(user, title.id)) {
          users.setUserTitle(user.id, title.id);
          grantedTitleId = title.id;
          notes.push(`头衔「${title.name}」`);
          if (why) notes.push(why);
        } else {
          const fresh = users.findById(user.id);
          const current = users.allTitles().find((t) => t.id === fresh.title_id);
          notes.push(`已有管理员指派的头衔「${current ? current.name : "?"}」，未覆盖`);
        }
      }
    }
  }

  if (config.AFDIAN.rewardExp > 0) {
    users.addExp(user.id, config.AFDIAN.rewardExp);
    notes.push(`经验 +${config.AFDIAN.rewardExp}`);
  }

  return { text: notes.join("、"), titleId: grantedTitleId };
}

/**
 * 处理一笔订单：入库（幂等）+ 匹配用户 + 发奖。
 * @returns {{ok: boolean, duplicated?: boolean, matched?: boolean, reward?: string}}
 */
function handleOrder(rawOrder, source = "webhook") {
  const order = normalizeOrder(rawOrder || {});
  if (!order.outTradeNo) return { ok: false, error: "missing_out_trade_no" };

  const existing = db.prepare("SELECT id, user_id, reward FROM afdian_orders WHERE out_trade_no = ?").get(order.outTradeNo);
  if (existing) return { ok: true, duplicated: true, matched: Boolean(existing.user_id), reward: existing.reward || "" };

  const match = matchUser(order.remark);
  const info = db.prepare(
    `INSERT INTO afdian_orders
       (out_trade_no, afdian_user, plan_id, amount, months, status, remark, user_id, matched_by, reward, raw, created_at, received_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    order.outTradeNo,
    order.afdianUser || null,
    order.planId || null,
    order.amount || null,
    order.months,
    order.status,
    order.remark || null,
    match ? match.user.id : null,
    match ? match.via : "none",
    null,
    JSON.stringify(rawOrder || {}).slice(0, 2000),
    order.createdAt,
    Date.now()
  );

  // 只有「支付成功」才发奖；其它状态（退款/未支付）只记录
  let reward = "";
  let titleId = null;
  if (match && order.status === 2) {
    const granted = grantReward(match.user, order);
    reward = granted.text;
    titleId = granted.titleId;
    db.prepare("UPDATE afdian_orders SET reward = ?, title_id = ? WHERE id = ?")
      .run(reward || null, titleId, info.lastInsertRowid);
  } else if (match && order.status !== 2) {
    reward = "订单状态不是已支付，未发奖";
    db.prepare("UPDATE afdian_orders SET reward = ? WHERE id = ?").run(reward, info.lastInsertRowid);
  }

  return { ok: true, duplicated: false, matched: Boolean(match), reward, titleId, source };
}

/* ───────────────────────── 查询 API（补单/对账）───────────────────────── */

async function openApi(path, params) {
  if (!config.AFDIAN.apiReady) return { ok: false, error: "afdian_not_configured" };

  const body = {
    user_id: config.AFDIAN.userId,
    ts: Math.floor(Date.now() / 1000),
    params: JSON.stringify(params || {})
  };
  body.sign = sign({ params: body.params, ts: body.ts, userId: body.user_id });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.AFDIAN.timeoutMs);
  try {
    const res = await fetch(`${config.AFDIAN.apiBase}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || json.ec !== 200) {
      return { ok: false, error: (json && json.em) || ("HTTP " + res.status) };
    }
    return { ok: true, data: json.data };
  } catch (err) {
    return { ok: false, error: err && err.name === "AbortError" ? "请求超时" : String(err && err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 拉取最近若干页订单并补进本地库（回调丢失时用）。
 * 只补 status=2 的，且完全靠 out_trade_no 去重，重复执行安全。
 */
async function syncOrders(pages = 3) {
  let imported = 0;
  let duplicated = 0;
  const errors = [];

  for (let page = 1; page <= Math.max(1, Math.min(20, pages)); page += 1) {
    const res = await openApi("query-order", { page });
    if (!res.ok) {
      errors.push(`第 ${page} 页：${res.error}`);
      break;
    }
    const list = (res.data && res.data.list) || [];
    for (const order of list) {
      const result = handleOrder(order, "sync");
      if (!result.ok) continue;
      if (result.duplicated) duplicated += 1;
      else imported += 1;
    }
    const totalPage = Number(res.data && res.data.total_page) || 1;
    if (page >= totalPage) break;
  }

  return { ok: errors.length === 0, imported, duplicated, errors };
}

/* ───────────────────────────── 读 ───────────────────────────── */

function shapeOrder(row) {
  const user = row.user_id ? users.findById(row.user_id) : null;
  return {
    id: row.id,
    outTradeNo: row.out_trade_no,
    afdianUser: row.afdian_user || "",
    planId: row.plan_id || "",
    amount: row.amount || "",
    months: row.months,
    status: row.status,
    remark: row.remark || "",
    user: user ? users.publicUser(user) : null,
    matchedBy: row.matched_by || "none",
    reward: row.reward || "",
    createdAt: row.created_at,
    receivedAt: row.received_at
  };
}

function listOrders({ limit = 30, cursor = 0, filter = "all" } = {}) {
  const where = [];
  const args = [];
  if (filter === "unbound") where.push("user_id IS NULL AND (matched_by IS NULL OR matched_by <> 'ignored')");
  if (filter === "bound") where.push("user_id IS NOT NULL");
  const lastId = Number(cursor) || 0;
  if (lastId > 0) {
    where.push("id < ?");
    args.push(lastId);
  }

  const rows = db.prepare(
    `SELECT * FROM afdian_orders
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY id DESC LIMIT ?`
  ).all(...args, Math.min(100, Number(limit) || 30) + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: page.map(shapeOrder),
    nextCursor: hasMore && page.length ? page[page.length - 1].id : null
  };
}

function stats() {
  const one = (sql, ...args) => db.prepare(sql).pluck().get(...args);
  const amountRows = db.prepare("SELECT amount FROM afdian_orders WHERE status = 2").all();
  // 金额只做展示统计：用「分」为单位换算，避免浮点累加误差
  const cents = amountRows.reduce((sum, r) => sum + Math.round((Number(r.amount) || 0) * 100), 0);
  return {
    enabled: config.AFDIAN.enabled,
    webhookReady: config.AFDIAN.webhookReady,
    apiReady: config.AFDIAN.apiReady,
    tiers: config.AFDIAN.tiers.map((t) => ({ amount: (t.cents / 100).toFixed(2), title: t.title })),
    customKeyword: config.AFDIAN.customKeyword,
    rewardExp: config.AFDIAN.rewardExp,
    page: config.AFDIAN.page,
    total: one("SELECT COUNT(*) FROM afdian_orders"),
    paid: one("SELECT COUNT(*) FROM afdian_orders WHERE status = 2"),
    unbound: one("SELECT COUNT(*) FROM afdian_orders WHERE user_id IS NULL AND (matched_by IS NULL OR matched_by <> 'ignored')"),
    today: one("SELECT COUNT(*) FROM afdian_orders WHERE received_at > ?", Date.now() - 86400000),
    amount: (cents / 100).toFixed(2)
  };
}

/** 后台手动绑定：把一单算到某个用户头上并发奖 */
function bindOrder(orderId, uuid) {
  const row = db.prepare("SELECT * FROM afdian_orders WHERE id = ?").get(Number(orderId) || 0);
  if (!row) return { ok: false, error: "not_found" };
  const user = users.findByUuid(uuid);
  if (!user) return { ok: false, error: "user_not_found" };

  const granted = row.status === 2
    ? grantReward(user, row)
    : { text: "订单状态不是已支付，未发奖", titleId: null };
  db.prepare("UPDATE afdian_orders SET user_id = ?, matched_by = 'admin', reward = ?, title_id = ? WHERE id = ?")
    .run(user.id, granted.text || null, granted.titleId, row.id);
  return { ok: true, reward: granted.text, user: users.publicUser(user) };
}

/** 后台忽略一单（例如测试单、自己给自己下单） */
function ignoreOrder(orderId) {
  const info = db.prepare("UPDATE afdian_orders SET matched_by = 'ignored' WHERE id = ?").run(Number(orderId) || 0);
  if (!info.changes) return { ok: false, error: "not_found" };
  return { ok: true };
}

function recentWebhooks() {
  return recentAttempts.slice(0, RECENT_MAX);
}

module.exports = {
  sign,
  signSource,
  md5,
  parseWebhook,
  handleOrder,
  matchUser,
  normalizeOrder,
  grantReward,
  syncOrders,
  openApi,
  listOrders,
  stats,
  bindOrder,
  ignoreOrder,
  rememberAttempt,
  recentWebhooks
};
