"use strict";

/**
 * 内测版元信息（单一事实来源）。
 *
 * 版本号、站点标识、首屏公告与反馈开关都由服务端下发，前端不再硬编码 ——
 * 这样「改文案」不需要重新构建前端，运维改一个环境变量重启即可。
 *
 * 配置：
 *   BETA_VERSION      版本号，默认 0.9.0-beta.1（与 package.json 保持一致）
 *   BETA_NAME         版本标识，默认「内测版」
 *   BETA_NOTICE       首屏公告正文；留空用内置默认文案
 *   BETA_FEEDBACK     0 = 关闭反馈入口，默认开启
 *   FEEDBACK_EMAIL    可选：反馈邮箱（展示给用户，同时作为备用渠道）
 *   FEEDBACK_MAX      反馈正文最大长度，默认 800
 *   FEEDBACK_KEEP     反馈保留条数上限（超过后清理最旧的已处理反馈），默认 2000
 */

const VERSION = String(process.env.BETA_VERSION || "0.9.0-beta.1").trim();
const NAME = String(process.env.BETA_NAME || "内测版").trim();

const DEFAULT_NOTICE = [
  "本站处于内测阶段：功能、界面与数据都可能随时调整，历史内容可能被定期重置。",
  "请勿发布真实姓名、联系方式等隐私信息，也不要发布无法承受丢失的重要内容。",
  "遇到问题或有建议，欢迎通过页脚「内测反馈」告诉我们。"
].join("");

const NOTICE = String(process.env.BETA_NOTICE || "").trim() || DEFAULT_NOTICE;
const FEEDBACK_ENABLED = process.env.BETA_FEEDBACK !== "0";
const FEEDBACK_EMAIL = String(process.env.FEEDBACK_EMAIL || "").trim();
const FEEDBACK_MAX = Math.max(20, Math.min(4000, Number(process.env.FEEDBACK_MAX || 800)));
const FEEDBACK_KEEP = Math.max(100, Number(process.env.FEEDBACK_KEEP || 2000));

/** 下发给前端的公开信息（不含任何机密） */
function publicConfig() {
  return {
    version: VERSION,
    name: NAME,
    notice: NOTICE,
    feedback: FEEDBACK_ENABLED,
    feedbackEmail: FEEDBACK_EMAIL,
    feedbackMax: FEEDBACK_MAX
  };
}

module.exports = {
  VERSION,
  NAME,
  NOTICE,
  FEEDBACK_ENABLED,
  FEEDBACK_EMAIL,
  FEEDBACK_MAX,
  FEEDBACK_KEEP,
  publicConfig
};
