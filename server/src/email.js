"use strict";

/**
 * 邮件发送：验证码走 Cloudflare Email Service（REST API）。
 *
 * 为什么用 REST 而不是 Workers 的 send_email 绑定：
 *   本站后端是自托管的 Node 进程（node:http + SQLite），不是 Worker，
 *   没有绑定可用。Cloudflare 官方为这种场景提供了 REST 接口：
 *     POST /accounts/{account_id}/email/sending/send
 *     Authorization: Bearer <API_TOKEN>
 *     { to, from, subject, html, text }
 *   与 Worker 绑定的字段差异要注意：REST 侧 from 是字符串地址（或 {address,name}），
 *   Worker 侧是 {email,name}；写错会 400。
 *
 * 未配置凭据时的降级（自托管场景必须能自救）：
 *   1. 把验证码打到服务端 stderr（运维在面板日志里就能看到）；
 *   2. 落一份到 server/data/outbox/*.json（便于脚本化/审计）。
 *   两条降级路径都会带一条醒目告警，提醒「生产必须配上 Cloudflare」。
 */

const fs = require("fs");
const path = require("path");

const config = require("./config");

const OUTBOX_DIR = path.resolve(
  process.env.OUTBOX_DIR || path.join(__dirname, "..", "data", "outbox")
);

/** 发送结果：{ok, delivered?, queued?, error?} */
async function sendMail({ to, subject, html, text }) {
  const payload = {
    to,
    from: config.EMAIL.fromName
      ? { address: config.EMAIL.from, name: config.EMAIL.fromName }
      : config.EMAIL.from,
    subject,
    html,
    text
  };

  if (!config.EMAIL.configured) return degrade(to, payload, "未配置 Cloudflare 邮件通道");

  const url = config.EMAIL.apiBase
    + "/accounts/" + encodeURIComponent(config.EMAIL.accountId)
    + "/email/sending/send";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.EMAIL.timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + config.EMAIL.token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const body = await res.json().catch(() => ({}));

    if (!res.ok || body.success === false) {
      const detail = Array.isArray(body.errors) && body.errors.length
        ? body.errors.map((e) => e.message || e.code).join("; ")
        : "HTTP " + res.status;
      console.error("[email] Cloudflare 发送失败：" + detail);
      // 发送失败也要留下验证码痕迹，否则用户会卡在登录页且无人知道为什么
      degrade(to, payload, "Cloudflare 发送失败：" + detail);
      return { ok: false, error: detail };
    }

    const result = body.result || {};
    return {
      ok: true,
      delivered: result.delivered || [],
      queued: result.queued || [],
      permanentBounces: result.permanent_bounces || []
    };
  } catch (err) {
    const detail = err && err.name === "AbortError" ? "请求超时" : (err && err.message) || String(err);
    console.error("[email] Cloudflare 请求异常：" + detail);
    degrade(to, payload, "Cloudflare 请求异常：" + detail);
    return { ok: false, error: detail };
  } finally {
    clearTimeout(timer);
  }
}

/** 降级：控制台 + outbox 文件。**不静默**，每次都会告警。 */
function degrade(to, payload, why) {
  console.warn(
    "[email] " + why + " —— 未外发。验证码已写入 server/data/outbox/ 与服务端日志；"
    + "生产环境请在 server/.env 配置 CF_ACCOUNT_ID / CF_EMAIL_TOKEN / CF_EMAIL_FROM。"
  );
  try {
    fs.mkdirSync(OUTBOX_DIR, { recursive: true });
    const name = Date.now() + "-" + String(to).replace(/[^a-zA-Z0-9._@-]/g, "_") + ".json";
    fs.writeFileSync(path.join(OUTBOX_DIR, name), JSON.stringify({
      to,
      subject: payload.subject,
      text: payload.text,
      at: Date.now(),
      degradedBecause: why
    }, null, 2), "utf8");
  } catch (err) {
    console.warn("[email] 写 outbox 失败：" + err.message);
  }
  return { ok: false, degraded: true, error: why };
}

/** 验证码邮件正文：同时给 html 与 text —— 只有 html 容易被判为垃圾邮件 */
function codeMail({ code, siteName, ttlMinutes, purpose }) {
  const action = purpose === "register" ? "注册" : "登录";
  const subject = siteName + " " + action + "验证码：" + code;
  const text = [
    "你的" + action + "验证码是：" + code,
    "",
    "验证码 " + ttlMinutes + " 分钟内有效，请勿转发给任何人。",
    "如果这不是你本人的操作，忽略本邮件即可。",
    "",
    siteName
  ].join("\n");

  const html = [
    '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,PingFang SC,Microsoft YaHei,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#1d1d1f">',
    '<h1 style="font-size:20px;margin:0 0 16px">' + escapeHtml(siteName) + " " + action + "验证码</h1>",
    '<p style="font-size:32px;font-weight:600;letter-spacing:.12em;margin:0 0 16px">' + code + "</p>",
    '<p style="font-size:14px;color:#6e6e73;margin:0 0 8px">验证码 ' + ttlMinutes + " 分钟内有效，请勿转发给任何人。</p>",
    '<p style="font-size:14px;color:#6e6e73;margin:0">如果这不是你本人的操作，忽略本邮件即可。</p>',
    "</div>"
  ].join("");

  return { subject, text, html };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

module.exports = { sendMail, codeMail, OUTBOX_DIR };
