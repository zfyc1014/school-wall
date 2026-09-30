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
 *
 * 本轮增强（都是为「规则命中率」服务，不改变「命中即转人工」的定位）：
 *
 *   1. **匹配前先归一化。** 先做 Unicode NFKC（全角数字/字母/符号折成半角），
 *      再去掉零宽字符（\u200b-\u200f、\ufeff 等）——这些字符肉眼不可见，
 *      却是最常用的绕词手段。
 *
 *   2. **对易被拆开的模式再匹配一次「紧凑形态」。** 手机号写成
 *      `1 3 8-0013 8000` 或 `138.0013.8000` 时，直接套正则会漏。
 *      紧凑形态删掉空白与常见分隔符后再匹配，仅用于
 *      手机号 / 学号 / 社交账号 / 身份证这类结构性模式；
 *      邮箱与中文关键词不参与 —— 删掉 `.` 会把邮箱拆坏，删掉空格又可能
 *      把句子里相邻的字粘成词造成误判。
 *
 *   3. **词表按 mtime 自动重载。** 运营改 `banned.txt` 后无需重启进程，
 *      默认 30 秒内生效（`BANNED_RELOAD_MS` 可调，设 0 则关闭热重载）。
 */

const fs = require("fs");
const path = require("path");

// 联系方式 / 可识别个人资料 → 起底（doxxing）风险，命中即转人工。
// compact: true 表示该规则额外在「紧凑形态」（去掉空白与分隔符）上匹配一次。
const RULES = [
  { name: "hk_phone", re: /(?:\+?852[\s-]?)?[2-9]\d{7}\b/, compact: true },
  { name: "cn_phone", re: /\b1[3-9]\d{9}\b/, compact: true },
  { name: "email", re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i },
  { name: "hkid", re: /\b[A-Z]{1,2}\d{6}\(\d\)/, compact: true },
  { name: "social", re: /(微信|wechat|qq|ig|instagram|telegram|whatsapp|line)\s*[:：]?\s*[a-z0-9._-]{4,}/i, compact: true },
  { name: "student_id", re: /(学号|學號|student\s*id)\s*[:：]?\s*[a-z0-9]{5,}/i, compact: true },
  { name: "address", re: /(家庭住址|住址|宿舍|门牌|門牌|详细地址|詳細地址)\s*[:：]?/ }
];

// 明确的起底语义提示词（仅作为复核信号，不作自动处置）
const DOXX_HINTS = [
  "真实姓名", "真實姓名", "身份证", "身份證", "家庭住址", "宿舍号", "宿舍號",
  "手机号", "手機號", "电话号码", "電話號碼", "班级", "班級", "导员", "輔導員"
];

const ZERO_WIDTH = /[\u200b-\u200f\u2028\u2029\ufeff]/g;
// 紧凑化时删除的字符：空白、点、下划线、常见连接符与括号
const SEPARATORS = /[\s._*·・\-—–~～|/\\()（）\[\]【】]+/g;

/** NFKC + 去零宽：全角折半角、兼容字符归一，并移除肉眼不可见的零宽字符 */
function normalize(text) {
  let s = String(text == null ? "" : text);
  try {
    s = s.normalize("NFKC");
  } catch {
    /* 运行时没有 normalize 时保持原样 */
  }
  return s.replace(ZERO_WIDTH, "");
}

/**
 * 紧凑形态：在归一化基础上删掉空白与常见分隔符。
 * 仅供结构性规则使用，不用于中文关键词匹配。
 */
function compact(text) {
  return normalize(text).replace(SEPARATORS, "");
}

/**
 * 只去空白的形态：用于中文敏感词匹配。
 * 词表匹配的误判代价是「进人工队列」而不是「被删」，所以这里宁可多命中一次。
 */
function squash(text) {
  return normalize(text).replace(/\s+/g, "");
}

/* ───────────────────────────── 词表加载 / 热重载 ───────────────────────────── */

const BANNED_FILE = path.resolve(
  process.env.BANNED_FILE || path.join(__dirname, "..", "data", "banned.txt")
);
const BANNED_RELOAD_MS = Number(
  process.env.BANNED_RELOAD_MS == null ? 30000 : process.env.BANNED_RELOAD_MS
);

let bannedWords = [];
let bannedMtime = 0;
let bannedCheckedAt = 0;

/**
 * 按 mtime 判断词表是否需要重载。
 * 默认最多每 30 秒 stat 一次文件 —— 这点 IO 相对一次请求可以忽略，
 * 换来的是运营改词表后不必重启服务。
 *
 * @param {boolean} force 忽略节流与 mtime，强制重读
 */
function refreshBanned(force = false) {
  const now = Date.now();
  if (!force && !BANNED_RELOAD_MS) return;
  if (!force && now - bannedCheckedAt < BANNED_RELOAD_MS) return;
  bannedCheckedAt = now;

  let mtime = 0;
  try {
    mtime = fs.statSync(BANNED_FILE).mtimeMs;
  } catch {
    mtime = 0; // 无词表文件
  }
  if (!force && mtime === bannedMtime) return;

  try {
    bannedWords = fs
      .readFileSync(BANNED_FILE, "utf8")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("#"));
  } catch {
    bannedWords = []; // 无词表时只跑结构性规则
  }
  bannedMtime = mtime;
}

refreshBanned(true);

/* ───────────────────────────── 分类 ───────────────────────────── */

/**
 * @param {string} raw 用户提交的纯文本
 * @returns {{flagged: boolean, flags: string[]}}
 */
function classify(raw) {
  refreshBanned();

  const text = normalize(raw);
  const tight = compact(raw);
  const flat = squash(raw);
  const flags = [];

  for (const rule of RULES) {
    if (rule.re.test(text) || (rule.compact && rule.re.test(tight))) {
      flags.push(rule.name);
    }
  }
  for (const hint of DOXX_HINTS) {
    // hint 本身经 NFKC 后与原文一致，这里统一用归一化文本匹配
    if (text.includes(hint) || flat.includes(hint)) flags.push("doxx:" + hint);
  }
  for (const word of bannedWords) {
    if (word && (text.includes(word) || flat.includes(word))) {
      flags.push("banned");
      break; // 只记一次，避免名单泄露结构
    }
  }

  return { flagged: flags.length > 0, flags: flags.slice(0, 8) };
}

module.exports = {
  classify,
  normalize,
  ruleCount: RULES.length + DOXX_HINTS.length,
  reloadBanned: () => refreshBanned(true),
  bannedFile: BANNED_FILE
};
