"use strict";

/**
 * Brevo（原 Sendinblue）v3 API 客户端：事务邮件 + 事务短信。
 *
 * 官方接口（v3）：
 *   邮件  POST /smtp/email                  { sender:{name,email}, to:[{email}], subject, htmlContent, textContent }
 *   短信  POST /transactionalSMS/sms          { sender, recipient, content, type:"transactional", tag? }
 *   账号  GET  /account                        （自检：套餐与额度）
 *   发件人 GET  /senders                        （自检：哪个地址是已验证的）
 * 认证统一用请求头 `api-key: <key>`。
 *
 * 选它的理由：一个服务同时提供「邮件」与「短信」，验证码两条通道可以共用一个额度账单；
 * 这对自托管的小站很重要 —— 少接一家、少一套密钥、少一个故障点。
 *
 * ⚠️ 两个最常见的坑，这里都翻译成人话回给调用方：
 *   1. Brevo 账号可能开了「授权 IP」限制 —— 服务器出口 IP 没加白名单时，所有请求 401，
 *      错误信息里会点名那个 IP。运维必须先去 Brevo → Security → Authorised IPs 加白名单。
 *   2. 短信需要 sender（发送方名称）审核通过，且 recipient 必须是 E.164（+ 国家码）格式。
 */

const config = require("./config");

function enabled() {
  return config.BREVO.enabled;
}
function emailReady() {
  return config.BREVO.emailReady;
}
function smsReady() {
  return config.BREVO.smsReady;
}

/**
 * 发一个 v3 请求。
 * @returns {Promise<{ok: boolean, status: number, json: any, error?: string}>}
 */
async function request(path, { method = "GET", body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.BREVO.timeoutMs);
  try {
    const res = await fetch(config.BREVO.apiBase + path, {
      method,
      headers: Object.assign(
        { "api-key": config.BREVO.apiKey, accept: "application/json" },
        body ? { "content-type": "application/json" } : {}
      ),
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 300) }; }
    return { ok: res.ok, status: res.status, json };
  } catch (err) {
    const detail = err && err.name === "AbortError" ? "请求超时" : (err && err.message) || String(err);
    return { ok: false, status: 0, json: null, error: detail };
  } finally {
    clearTimeout(timer);
  }
}

/** 把 Brevo 的错误翻成「该去哪改哪里」，而不是丢一串英文给运维 */
function explain(status, json, transportError) {
  if (transportError) return "请求失败：" + transportError;
  const msg = (json && (json.message || json.error)) || ("HTTP " + status);
  if (status === 401 && /unrecognised IP address/i.test(msg)) {
    return "Brevo 拒绝了该服务器 IP：请到 Brevo → Security → Authorised IPs 把服务器出口 IP 加进白名单"
      + "（错误里点名的那一个就是它看到的 IP）";
  }
  if (status === 401) return "Brevo 拒绝了 API key：检查 BREVO_API_KEY 是否正确/被撤销（" + msg + "）";
  if (status === 403) return "Brevo 无权限：" + msg;
  if (status === 400 && /sender|from/i.test(msg)) {
    return "发件人不可用：到 Brevo → Senders 确认该地址已激活（" + msg + "）";
  }
  if (status === 400 && /credit|balance/i.test(msg)) return "额度不足：" + msg;
  return msg;
}

/** 发送事务邮件 */
async function sendEmail({ to, subject, html, text }) {
  if (!config.BREVO.emailReady) {
    return { ok: false, provider: "brevo", error: "Brevo 未配置发件地址（BREVO_SENDER_EMAIL）" };
  }
  const r = await request("/smtp/email", {
    method: "POST",
    body: {
      sender: { name: config.BREVO.senderName, email: config.BREVO.senderEmail },
      to: [{ email: to }],
      subject,
      htmlContent: html,
      textContent: text
    }
  });
  if (!r.ok) {
    const error = explain(r.status, r.json, r.error);
    console.error("[brevo] 邮件发送失败：" + error);
    return { ok: false, provider: "brevo", error, status: r.status };
  }
  return { ok: true, provider: "brevo", id: (r.json && r.json.messageId) || "" };
}

/** 发送事务短信（recipient 必须是 E.164，+8613800138000 这种） */
async function sendSms({ to, content, tag }) {
  if (!config.BREVO.smsReady) {
    return { ok: false, provider: "brevo", error: "Brevo 未配置短信 sender（BREVO_SMS_SENDER）" };
  }
  const body = { sender: config.BREVO.smsSender, recipient: to, content, type: "transactional" };
  if (tag) body.tag = tag;
  const r = await request("/transactionalSMS/sms", { method: "POST", body });
  if (!r.ok) {
    const error = explain(r.status, r.json, r.error);
    console.error("[brevo] 短信发送失败：" + error);
    return { ok: false, provider: "brevo", error, status: r.status };
  }
  return { ok: true, provider: "brevo", id: (r.json && r.json.reference) || "" };
}

/** 后台自检用：账号套餐与额度 */
async function accountInfo() {
  const r = await request("/account");
  if (!r.ok) return { ok: false, error: explain(r.status, r.json, r.error), status: r.status };
  const plan = (r.json && r.json.plan) || [];
  return {
    ok: true,
    email: (r.json && r.json.email) || "",
    companyName: (r.json && r.json.companyName) || "",
    plan: plan.map((p) => p.type + ":" + p.creditsType + "=" + p.credits)
  };
}

/** 后台自检用：哪些发件地址可用 */
async function listSenders() {
  const r = await request("/senders");
  if (!r.ok) return { ok: false, error: explain(r.status, r.json, r.error), status: r.status };
  const list = Array.isArray(r.json && r.json.senders) ? r.json.senders : [];
  return {
    ok: true,
    senders: list.map((s) => ({ email: s.email, name: s.name, active: Boolean(s.active) })),
    active: list.filter((s) => s.active).map((s) => s.email)
  };
}

module.exports = { enabled, emailReady, smsReady, sendEmail, sendSms, accountInfo, listSenders, explain };
