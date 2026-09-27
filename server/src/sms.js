"use strict";

/**
 * 短信网关（可插拔）。
 *
 * 为什么不直接绑定某一家：你在香港运营，而主流短信通道的可用性与合规门槛差别很大 ——
 * 中国大陆通道要模板报备 + 企业资质，国际通道（Twilio 等）对香港/海外号码更顺，
 * 但中国大陆号码的到达率会打折。这个选择必须留给你，不能写死在代码里。
 *
 * 三种模式（SMS_PROVIDER）：
 *   log     默认。不真的发短信，把验证码打到服务端日志。
 *           **仅限开发**：生产用它等于任何人都能拿到验证码，必须显式确认才允许。
 *   webhook 通用模式。POST { phone, code, text } 到你自己的网关/中转服务，
 *           由它对接具体通道。适合用阿里云/腾讯云函数或自建中转。
 *   twilio  内置 Twilio 实现（国际通道，香港可用）。
 *
 * 返回统一为 { ok, id?, error? }，调用方不关心具体通道。
 */

const PROVIDER = String(process.env.SMS_PROVIDER || "log").toLowerCase();
const IS_PROD = process.env.NODE_ENV === "production";
const TIMEOUT_MS = Number(process.env.SMS_TIMEOUT_MS || 8000);

let warnedInProd = false;

/** 校验生产环境是否允许当前配置 */
function assertUsable() {
  if (PROVIDER === "log" && IS_PROD && process.env.SMS_ALLOW_LOG_IN_PROD !== "1") {
    return {
      ok: false,
      fatal: "SMS_PROVIDER=log 在生产环境等同于不验证手机号（任何人都能从日志拿到验证码）。"
        + "请配置 webhook 或 twilio 通道；确需临时如此，请显式设置 SMS_ALLOW_LOG_IN_PROD=1。"
    };
  }
  if (PROVIDER === "webhook" && !process.env.SMS_WEBHOOK_URL) {
    return { ok: false, fatal: "SMS_PROVIDER=webhook 但未配置 SMS_WEBHOOK_URL" };
  }
  if (PROVIDER === "twilio") {
    const need = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM"];
    const missing = need.filter((k) => !process.env[k]);
    if (missing.length) return { ok: false, fatal: `SMS_PROVIDER=twilio 但缺少：${missing.join(", ")}` };
  }
  return { ok: true };
}

/**
 * @param {{ phone: string, code: string, ttlMinutes: number }} payload
 * @returns {Promise<{ ok: boolean, id?: string, error?: string }>}
 */
async function send({ phone, code, ttlMinutes }) {
  const usable = assertUsable();
  if (!usable.ok) return { ok: false, error: usable.fatal };

  const text = `【校园表白墙】验证码 ${code}，${ttlMinutes} 分钟内有效。`
    + "请勿转发给他人；平台不会以任何理由索要该验证码。";

  if (PROVIDER === "log") {
    if (!warnedInProd) {
      console.warn(`[sms] log 模式：验证码只写日志、不发送。phone=${maskPhoneForLog(phone)} code=${code}`);
      if (IS_PROD) console.warn("[sms] 你正在生产环境使用 log 模式，这等于没有实名验证");
      warnedInProd = true;
    } else {
      console.log(`[sms] log 模式：phone=${maskPhoneForLog(phone)} code=${code}`);
    }
    return { ok: true, id: "log" };
  }

  if (PROVIDER === "webhook") {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(process.env.SMS_WEBHOOK_URL, {
        method: "POST",
        headers: Object.assign(
          { "content-type": "application/json" },
          process.env.SMS_WEBHOOK_TOKEN
            ? { authorization: `Bearer ${process.env.SMS_WEBHOOK_TOKEN}` }
            : {}
        ),
        body: JSON.stringify({ phone, code, text, ttlMinutes }),
        signal: controller.signal
      });
      if (!res.ok) return { ok: false, error: `短信网关返回 ${res.status}` };
      let id = "";
      try {
        const data = await res.json();
        id = String(data.id || data.requestId || "");
      } catch { /* 网关可能不返回 JSON */ }
      return { ok: true, id };
    } catch (err) {
      const reason = err?.name === "AbortError" ? "短信网关超时" : `短信网关不可达：${err.message}`;
      return { ok: false, error: reason };
    } finally {
      clearTimeout(timer);
    }
  }

  if (PROVIDER === "twilio") {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
    const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
    const body = new URLSearchParams({ To: phone, From: process.env.TWILIO_FROM, Body: text });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Basic ${auth}`,
          "content-type": "application/x-www-form-urlencoded"
        },
        body,
        signal: controller.signal
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 不把网关原始报文回给前端，避免泄露账号信息；只记服务端日志
        console.warn("[sms] twilio 发送失败：", data.code || res.status, data.message || "");
        return { ok: false, error: "短信发送失败，请稍后重试" };
      }
      return { ok: true, id: String(data.sid || "") };
    } catch (err) {
      const reason = err?.name === "AbortError" ? "短信网关超时" : `短信网关不可达：${err.message}`;
      return { ok: false, error: reason };
    } finally {
      clearTimeout(timer);
    }
  }

  return { ok: false, error: `未知的 SMS_PROVIDER：${PROVIDER}` };
}

/** 日志里也不该出现完整号码 */
function maskPhoneForLog(phone) {
  const s = String(phone || "");
  if (s.length < 7) return "***";
  return `${s.slice(0, 3)}****${s.slice(-4)}`;
}

module.exports = { send, provider: PROVIDER, assertUsable };
