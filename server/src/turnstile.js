"use strict";

/**
 * Cloudflare Turnstile 服务端校验（canonical siteverify）。
 *
 * 保护的面：`POST /api/auth/code`（发送邮箱验证码）。
 * 选它的理由：这是全站唯一会**花钱 + 对外发信**的入口，也是注册漏斗的第一道门；
 * 被脚本刷起来的后果不是多几条脏数据，而是把发信额度烧光、把域名信誉打坏。
 * 表白/论坛的写入有「先审后发 + 限流」兜底，不需要每个动作都弹人机验证。
 *
 * 三条硬性要求（缺一条就等于没做）：
 *   1. **服务端必须校验**：前端 widget 只是「帮用户拿一个 token」，token 不校验等于装饰品；
 *   2. **action 必须一致**：token 是给 `login` 这个动作签发的，就不能拿去顶别的动作；
 *   3. **hostname 白名单必须校验**：token 可能是别处的 widget 拿的，
 *      不比对 hostname 就等于允许「用别人的站点的验证来打我们的接口」。
 *
 * 校验失败一律 fail-closed（Cloudflare 不可达也拒绝），与官方示例一致：
 * 这是登录入口，宁可暂时登不上，也不能在验证服务挂掉时对全网站开门。
 */

const config = require("./config");

/** 是否启用：siteKey（给前端渲染）与 secretKey（服务端校验）都在才算配好 */
function enabled() {
  return Boolean(config.TURNSTILE.siteKey && config.TURNSTILE.secretKey);
}

/**
 * @param {{token?: string, ip?: string, action?: string}} input
 *   action：本次请求对应的 widget 动作名，默认用 TURNSTILE_ACTION。
 *           一个站可以有多个受保护面（登录、绑定手机号…），每面签发自己的 action，
 *           服务端只接受与本面匹配的 token。
 * @returns {Promise<{ok: boolean, skipped?: boolean, status?: number, code?: string, reason?: string}>}
 */
async function verify({ token, ip, action } = {}) {
  if (!enabled()) return { ok: true, skipped: true };

  const expectedHosts = config.TURNSTILE.hostnames;
  // 白名单为空 = 配置没配完。这里必须拒绝：拿不到 hostname 就无法判断 token 的来源。
  if (!expectedHosts.length) {
    console.error("[turnstile] 未配置 TURNSTILE_HOSTNAMES：无法校验 token 来源，已拒绝请求。"
      + "请在 server/.env 填上站点的正式域名（本地开发再追加 localhost,127.0.0.1）");
    return { ok: false, status: 503, code: "turnstile_misconfigured", reason: "no_hostnames" };
  }

  const value = String(token || "").trim();
  if (!value) return { ok: false, status: 400, code: "turnstile_required", reason: "missing_token" };
  // Turnstile 的 token 长度有限，过长的直接拒掉，避免把超大字符串转给 Cloudflare
  if (value.length > 2048) return { ok: false, status: 400, code: "turnstile_required", reason: "token_too_long" };

  const body = new URLSearchParams({ secret: config.TURNSTILE.secretKey, response: value });
  if (ip) body.set("remoteip", String(ip));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.TURNSTILE.timeoutMs);
  let res;
  let result;
  try {
    res = await fetch(config.TURNSTILE.verifyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: controller.signal
    });
    result = await res.json().catch(() => null);
  } catch (err) {
    console.error("[turnstile] siteverify 请求失败：" + (err && err.name === "AbortError" ? "超时" : (err && err.message) || err));
    return { ok: false, status: 503, code: "turnstile_unavailable", reason: "verify_unreachable" };
  } finally {
    clearTimeout(timer);
  }

  // 与官方示例等价：HTTP 不成功、或 Cloudflare 说 success !== true，都拒绝
  if (!res.ok || !result || result.success !== true) {
    const codes = (result && result["error-codes"]) || [];
    console.warn("[turnstile] 校验未通过：" + (codes.join(",") || ("HTTP " + res.status)));
    return { ok: false, status: 403, code: "turnstile_failed", reason: codes.join(",") || "verify_failed" };
  }

  // action 必须与签发时一致（防止拿别处的 token 来顶这个动作）
  const expectedAction = action || config.TURNSTILE.action;
  if (result.action !== expectedAction) {
    console.warn(`[turnstile] action 不匹配：期望 ${expectedAction}，实际 ${result.action}`);
    return { ok: false, status: 403, code: "turnstile_failed", reason: "action_mismatch" };
  }

  // hostname 必须在白名单里（防止拿别的站点的验证来打我们的接口）
  if (!expectedHosts.includes(result.hostname)) {
    console.warn(`[turnstile] hostname 不在白名单：${result.hostname}（允许：${expectedHosts.join(",")}）`);
    return { ok: false, status: 403, code: "turnstile_failed", reason: "hostname_mismatch" };
  }

  return { ok: true };
}

module.exports = { enabled, verify };
