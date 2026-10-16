"use strict";

/**
 * 站点配置（单一事实来源）。
 *
 * v1.0.0 起不再有「内测版」概念：版本号、站点名、邮件通道、论坛审核口径
 * 全部集中在这里，前端通过 GET /api/site 拿到，不硬编码。
 *
 * 面板部署（Pterodactyl / Wispbyte 之类没有 shell）只能写文件，所以所有配置
 * 都从 server/.env 读（见 src/env.js），环境变量优先。
 */

const VERSION = "1.0.0";

const SITE_NAME = String(process.env.SITE_NAME || "校园墙").trim() || "校园墙";

/* ───────────────────────── 邮件（Cloudflare Email Service）─────────────────────────
 *
 * 验证码通过 Cloudflare Email Sending 的 REST 接口发送：
 *   POST https://api.cloudflare.com/client/v4/accounts/{account_id}/email/sending/send
 * 需要三样东西：账号 ID、带邮件发送权限的 API Token、以及一个已经接入
 * Email Sending 的发信域名（发信地址必须是该域名下的地址）。
 *
 * 部署前用 wrangler email sending list 确认域名已接入。
 * 三者缺一即为「未配置」：这时验证码不会外发，而是写进服务端日志与
 * server/data/outbox/ 目录，并且在非生产环境下回带在接口响应里（devCode），
 * 方便本地自测；生产环境永远不会把验证码返回给调用方。
 * ------------------------------------------------------------------------- */
const EMAIL = {
  accountId: String(process.env.CF_ACCOUNT_ID || "").trim(),
  token: String(process.env.CF_EMAIL_TOKEN || "").trim(),
  from: String(process.env.CF_EMAIL_FROM || "").trim(),
  fromName: String(process.env.CF_EMAIL_FROM_NAME || SITE_NAME).trim(),
  apiBase: String(process.env.CF_API_BASE || "https://api.cloudflare.com/client/v4").trim(),
  timeoutMs: Math.max(1000, Number(process.env.CF_EMAIL_TIMEOUT_MS || 8000))
};
EMAIL.configured = Boolean(EMAIL.accountId && EMAIL.token && EMAIL.from);

/** 本地调试：把验证码直接回带在响应里。生产环境强制关闭（见 auth 模块的断言）。 */
const CODE_ECHO = process.env.AUTH_CODE_ECHO === "1" && process.env.NODE_ENV !== "production";

/** 验证码有效期（秒），默认 10 分钟 */
const CODE_TTL = Math.max(60, Math.min(3600, Number(process.env.AUTH_CODE_TTL || 600)));

/** 验证码重发间隔（秒）与每小时上限 */
const CODE_RESEND_SEC = Math.max(30, Number(process.env.AUTH_CODE_RESEND || 60));
const CODE_HOURLY_MAX = Math.max(1, Number(process.env.AUTH_CODE_HOURLY_MAX || 5));

/** 会话有效期（天），默认 30 天 */
const SESSION_DAYS = Math.max(1, Math.min(365, Number(process.env.SESSION_DAYS || 30)));

/** 会话 cookie 名 */
const SESSION_COOKIE = String(process.env.SESSION_COOKIE || "od_session").trim() || "od_session";

/** 论坛是否全量先审后发（默认 0：只有命中预筛的内容才转人工） */
const FORUM_PREMOD = process.env.FORUM_PREMOD === "1";

/** 昵称修改冷却（小时），默认 168 小时 = 7 天 */
const NICKNAME_COOLDOWN_H = Math.max(0, Number(process.env.NICKNAME_COOLDOWN_H || 168));

/* ───────────────────────── 爱发电（赞助）─────────────────────────
 *
 * 配置来自 https://afdian.com/dashboard/dev ：
 *   AFDIAN_USER_ID    开发者页的「用户 ID」
 *   AFDIAN_TOKEN      开发者页的「API Token」（校验回调签名、查询订单都要它）
 *   AFDIAN_PAGE       你的爱发电主页，例如 https://afdian.com/a/xxx（前端「支持校园墙」入口）
 *
 * 三者缺任意一个，赞助功能就视为未配置：接口 404、前端不显示入口，
 * 服务本身完全不受影响 —— 赞助是可选功能，不该成为部署门槛。
 *
 * **按金额分档发奖**（AFDIAN_REWARD_TIERS，默认 5:股东;10:@custom）：
 *   `金额:头衔名` 用英文分号分隔，取「不超过订单金额的最高档」；
 *   `@custom` 表示用用户在留言里自填的头衔（关键词 `头衔：xxxx`，见 AFDIAN_CUSTOM_KEYWORD）。
 *   自定义头衔不可用（没写/太长/含违禁词/冒名官方）时，自动回落到该金额以下的最高固定档；
 *   如果连固定档都没有，就只记录不发奖 —— 全程无需人工审批。
 * ------------------------------------------------------------------- */

/** 解析档位表：`5:股东;10:@custom` → [{cents:500,title:'股东'},{cents:1000,title:'@custom'}] */
function parseTiers(raw) {
  return String(raw == null ? "" : raw)
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const idx = part.indexOf(":");
      const yuan = Number(part.slice(0, idx));
      const title = part.slice(idx + 1).trim();
      return { cents: Math.round(yuan * 100), title };
    })
    .filter((t) => Number.isFinite(t.cents) && t.cents > 0 && t.title)
    .sort((a, b) => a.cents - b.cents);
}
const AFDIAN = {
  userId: String(process.env.AFDIAN_USER_ID || "").trim(),
  token: String(process.env.AFDIAN_TOKEN || "").trim(),
  page: String(process.env.AFDIAN_PAGE || "").trim(),
  apiBase: String(process.env.AFDIAN_API_BASE || "https://afdian.com/api/open").trim(),
  tiers: parseTiers(process.env.AFDIAN_REWARD_TIERS == null ? "5:股东;10:@custom" : process.env.AFDIAN_REWARD_TIERS),
  customKeyword: String(process.env.AFDIAN_CUSTOM_KEYWORD || "头衔").trim() || "头衔",
  rewardExp: Math.max(0, Number(process.env.AFDIAN_REWARD_EXP || 0)),
  timeoutMs: Math.max(1000, Number(process.env.AFDIAN_TIMEOUT_MS || 8000))
};
/** 回调校验需要 token；查询/发奖 API 需要 userId + token；前端入口需要 page */
AFDIAN.webhookReady = Boolean(AFDIAN.token);
AFDIAN.apiReady = Boolean(AFDIAN.userId && AFDIAN.token);
AFDIAN.enabled = Boolean(AFDIAN.page || AFDIAN.webhookReady);

/** 功能开关：都开着，但允许运营按学校情况关掉论坛或私信 */
const FEATURES = {
  forum: process.env.FEATURE_FORUM !== "0",
  dm: process.env.FEATURE_DM !== "0"
};

/** 下发给前端的公开站点信息（不含任何机密） */
function publicConfig() {
  return {
    version: VERSION,
    siteName: SITE_NAME,
    emailConfigured: EMAIL.configured,
    features: FEATURES,
    // 前端据此决定要不要显示「支持校园墙」入口；没配置就完全不提这件事。
    // 档位规则也一并下发：用户得先知道「发多少、写什么」才会去下单。
    afdian: AFDIAN.page ? {
      page: AFDIAN.page,
      tiers: AFDIAN.tiers.map((t) => ({ amount: (t.cents / 100).toFixed(2), title: t.title })),
      customKeyword: AFDIAN.customKeyword
    } : null
  };
}

module.exports = {
  VERSION,
  SITE_NAME,
  EMAIL,
  CODE_ECHO,
  CODE_TTL,
  CODE_RESEND_SEC,
  CODE_HOURLY_MAX,
  SESSION_DAYS,
  SESSION_COOKIE,
  FORUM_PREMOD,
  NICKNAME_COOLDOWN_H,
  AFDIAN,
  parseTiers,
  FEATURES,
  publicConfig
};
