"use strict";

/**
 * 短信验证码。当前只有 Brevo 一个通道（v3 /transactionalSMS/sms）。
 *
 * 未配置时不「假装发出去」：返回 degraded，由调用方决定是否告诉用户
 * 「手机登录暂不可用」—— 手机登录入口本身也会因为 smsReady=false 而关闭，
 * 所以正常部署不会走到这条路径，它主要服务于「配置被撤掉」的中间状态。
 */

const config = require("./config");
const brevo = require("./brevo");

function enabled() {
  return config.BREVO.smsReady;
}

/** @returns {Promise<{ok: boolean, provider: string, degraded?: boolean, error?: string}>} */
async function sendSms({ to, content, tag }) {
  if (!enabled()) {
    console.warn("[sms] 未配置短信通道（BREVO_SMS_SENDER）—— 未外发。");
    return { ok: false, provider: "log", degraded: true, error: "未配置短信通道（BREVO_SMS_SENDER）" };
  }
  const result = await brevo.sendSms({ to, content, tag });
  if (result.ok) return result;
  // 失败时把内容打到日志：运维至少能在面板里看到这次验证码是多少（仅限自托管排障场景）
  console.warn("[sms] 发送失败：" + result.error + "；内容：" + content);
  return { ok: false, provider: "brevo", error: result.error };
}

/**
 * 验证码短信文案。
 * 注意长度：中文走 UCS-2，一条 70 字以内不拆分（超出会按多条计费）。
 */
function codeSms({ code, siteName, ttlMinutes, purpose }) {
  const action = purpose === "bind" ? "绑定手机号" : purpose === "register" ? "注册" : "登录";
  return siteName + action + "验证码：" + code + "，" + ttlMinutes + " 分钟内有效。请勿转发。";
}

module.exports = { enabled, sendSms, codeSms };
