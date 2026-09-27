"use strict";

/**
 * 内容合规预筛（香港运营场景）。
 *
 * 定位：这是「确定性的规则筛查 + 人工复核触发器」，不是自动判定系统。
 * 命中任何规则的内容一律进入人工复核队列，而不是被自动删除 —— 这样
 * 既降低管理成本，又避免误伤（合规风险由人工判断兜底）。
 *
 * 词表与正则必须由运营方按校情及执业律师意见持续维护。本文件只放
 * 结构性规则（联系方式、起底特征），敏感词表从外部文件按行加载，
 * 便于随时更新且不把敏感内容写进代码仓库。
 */

const fs = require("fs");
const path = require("path");

// 联系方式 / 可识别个人资料 → 起底（doxxing）风险，命中即转人工
const RULES = [
  { name: "hk_phone", re: /(?:\+?852[\s-]?)?[2-9]\d{7}\b/ },
  { name: "cn_phone", re: /\b1[3-9]\d{9}\b/ },
  { name: "email", re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i },
  { name: "hkid", re: /\b[A-Z]{1,2}\d{6}\(\d\)/ },
  { name: "social", re: /(微信|wechat|qq|ig|instagram|telegram|whatsapp|line)\s*[:：]?\s*[a-z0-9._-]{4,}/i },
  { name: "student_id", re: /(学号|學號|student\s*id)\s*[:：]?\s*[a-z0-9]{5,}/i },
  { name: "address", re: /(家庭住址|住址|宿舍|门牌|門牌|详细地址|詳細地址)\s*[:：]?/ }
];

// 明确的起底语义提示词（仅作为复核信号，不作自动处置）
const DOXX_HINTS = [
  "真实姓名", "真實姓名", "身份证", "身份證", "家庭住址", "宿舍号", "宿舍號",
  "手机号", "手機號", "电话号码", "電話號碼", "班级", "班級", "导员", "輔導員"
];

let bannedWords = [];
(function loadBanned() {
  const file = path.resolve(
    process.env.BANNED_FILE || path.join(__dirname, "..", "data", "banned.txt")
  );
  try {
    bannedWords = fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("#"));
  } catch {
    bannedWords = []; // 无词表时只跑结构性规则
  }
})();

/**
 * @param {string} raw 用户提交的纯文本
 * @returns {{flagged: boolean, flags: string[]}}
 */
function classify(raw) {
  const text = String(raw || "");
  const flags = [];

  for (const rule of RULES) {
    if (rule.re.test(text)) flags.push(rule.name);
  }
  for (const hint of DOXX_HINTS) {
    if (text.includes(hint)) flags.push("doxx:" + hint);
  }
  for (const word of bannedWords) {
    if (word && text.includes(word)) {
      flags.push("banned");
      break; // 只记一次，避免名单泄露结构
    }
  }

  return { flagged: flags.length > 0, flags: flags.slice(0, 8) };
}

module.exports = { classify, ruleCount: RULES.length + DOXX_HINTS.length };
