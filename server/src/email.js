"use strict";

/**
 * 邮件发送。支持两个服务商，按 config.EMAIL.provider 选择：
 *
 *   brevo      Brevo v3（POST /smtp/email）—— 与短信共用一个账号/账单，推荐
 *   cloudflare Cloudflare Email Service REST（POST /accounts/{id}/email/sending/send）
 *   log        都没配：只写服务端日志 + server/data/outbox/（自托管能自救）
 *
 * 为什么要保留两个服务商：Cloudflare 只发邮件，Brevo 邮件+短信。已经配好 Cloudflare 的
 * 部署不该因为加了短信就必须迁移；新部署直接上 Brevo 更省事。优先级见 config。
 *
 * 未配置/发送失败时的降级（自托管场景必须能自救）：
 *   1. 把验证码打到服务端 stderr（运维在面板日志里就能看到）；
 *   2. 落一份到 server/data/outbox/*.json（便于脚本化/审计）。
 * 两条降级路径都会带一条醒目告警，提醒「生产必须配上邮件通道」。
 */

const fs = require("fs");
const path = require("path");

const config = require("./config");
const brevo = require("./brevo");

const OUTBOX_DIR = path.resolve(
  process.env.OUTBOX_DIR || path.join(__dirname, "..", "data", "outbox")
);

/** 发送结果：{ok, provider, delivered?, queued?, error?} */
async function sendMail({ to, subject, html, text }) {
  const provider = config.EMAIL.provider;

  if (provider === "brevo") {
    const result = await brevo.sendEmail({ to, subject, html, text });
    if (result.ok) return result;
    // 失败也要留痕：否则用户卡在登录页，运维却不知道验证码是多少
    return degrade(to, { subject, text }, "Brevo 发送失败：" + result.error, "brevo");
  }

  if (provider === "cloudflare") {
    return sendViaCloudflare({ to, subject, html, text });
  }

  return degrade(
    to,
    { subject, text },
    "未配置任何邮件通道（BREVO_API_KEY 与 CF_* 都没配）",
    "log"
  );
}

/** Cloudflare Email Service REST */
async function sendViaCloudflare({ to, subject, html, text }) {
  const payload = {
    to,
    from: config.EMAIL.fromName
      ? { address: config.EMAIL.from, name: config.EMAIL.fromName }
      : config.EMAIL.from,
    subject,
    html,
    text
  };

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
      return degrade(to, payload, "Cloudflare 发送失败：" + detail, "cloudflare");
    }

    const result = body.result || {};
    return {
      ok: true,
      provider: "cloudflare",
      delivered: result.delivered || [],
      queued: result.queued || [],
      permanentBounces: result.permanent_bounces || []
    };
  } catch (err) {
    const detail = err && err.name === "AbortError" ? "请求超时" : (err && err.message) || String(err);
    console.error("[email] Cloudflare 请求异常：" + detail);
    return degrade(to, payload, "Cloudflare 请求异常：" + detail, "cloudflare");
  } finally {
    clearTimeout(timer);
  }
}

/** 降级：控制台 + outbox 文件。**不静默**，每次都会告警。 */
function degrade(to, payload, why, provider) {
  console.warn(
    "[email] " + why + " —— 未外发。验证码已写入 server/data/outbox/ 与服务端日志；"
    + "生产环境请在 server/.env 配置 BREVO_API_KEY + BREVO_SENDER_EMAIL"
    + "（或 CF_ACCOUNT_ID / CF_EMAIL_TOKEN / CF_EMAIL_FROM）。"
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
  return { ok: false, degraded: true, provider: provider || "log", error: why };
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
