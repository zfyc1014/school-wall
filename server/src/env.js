"use strict";

/**
 * 零依赖 .env 加载。
 *
 * 为什么服务端要自己读 .env（而不是只依赖 `node --env-file=.env`）：
 * 面板类部署（Pterodactyl / Wispbyte 等）**没有 shell**，启动命令被固定成
 * `node ${JS_FILE}` —— 既加不了 `--env-file`，也不方便往里注入十几个环境变量。
 * 把配置写成 `server/.env`（面板的文件管理器直接上传/编辑），服务就能跑起来。
 *
 * 语义与 Node 自带的 `--env-file` 保持一致：
 *   - **已存在的环境变量优先**：命令行、容器注入、systemd EnvironmentFile
 *     都高于 .env 文件，方便临时覆盖；
 *   - 支持 `KEY=VALUE`、`export KEY=VALUE`、`#` 注释、单双引号包裹的值；
 *   - 解析失败只跳过该行，绝不因为配置文件的格式问题让服务起不来。
 *
 * 这个模块在 require 时就生效（有副作用），因此必须在其它读取 process.env 的
 * 模块（db.js 读 DB_PATH、config.js 读 CF_* / SESSION_* 等）**之前**引用。
 */

const fs = require("fs");
const path = require("path");

/**
 * @param {string} file
 * @returns {number} 实际写入的键数量（0 表示文件不存在或没有新键）
 */
function loadEnvFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return 0; // 文件不存在是正常情况（systemd / 容器注入的环境变量）
  }

  let loaded = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue; // 真实环境变量优先

    let value = line.slice(eq + 1).trim();
    const quoted = (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) value = value.slice(1, -1);

    process.env[key] = value;
    loaded += 1;
  }
  return loaded;
}

const ENV_FILE = path.join(__dirname, "..", ".env");
const ENV_EXAMPLE = path.join(__dirname, "..", ".env.example");

/** 把 .env 文本解析成 { KEY: value }（只认未注释的行，逻辑与 loadEnvFile 一致） */
function parseEnvText(text) {
  const out = {};
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    const quoted = (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

/** 明显是占位符的值：不算「填了真实配置」 */
function looksPlaceholder(value) {
  if (!value) return true;
  const v = String(value).trim();
  if (v.length < 6) return true;
  return /<|your|example|xxx|todo|placeholder|请填写|你的/i.test(v)
    // 模板里的写法：change-me-to-a-long-random-token / replace-me / CHANGE_ME
    || /change[-_ ]?me|replace[-_ ]?me|random[-_ ]?(token|secret|string)/i.test(v);
}

/**
 * 找出「填在了 .env.example 里、但服务端不会读」的配置。
 *
 * 为什么要有这个自检：.env.example 是**被 git 跟踪的模板**，很多人（包括本站第一次部署）
 * 会把真实值直接写进它 —— 服务端只读 server/.env，于是这些配置全部不生效，
 * 而且日志里只会显示「未配置」，极难自行定位；更糟的是它会挡住下一次 git pull。
 * 只检查敏感/可选的键，避免把 HOST/NODE_ENV 这类默认项也报出来刷屏。
 */
const WATCHED_KEYS = [
  "ADMIN_TOKEN", "IP_HASH_SECRET",
  "BREVO_API_KEY", "BREVO_SENDER_EMAIL", "BREVO_SMS_SENDER", "MAIL_PROVIDER",
  "TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY", "TURNSTILE_HOSTNAMES",
  "CF_ACCOUNT_ID", "CF_EMAIL_TOKEN", "CF_EMAIL_FROM",
  "AFDIAN_USER_ID", "AFDIAN_TOKEN", "AFDIAN_PAGE"
];

/**
 * @param {{envText?: string, exampleText?: string}} [input] 传参便于单测，缺省读真实文件
 * @returns {string[]} 被写错文件的键名
 */
function findMisplacedConfig(input) {
  let envText = input && input.envText;
  let exampleText = input && input.exampleText;
  if (envText === undefined) {
    try { envText = fs.readFileSync(ENV_FILE, "utf8"); } catch { envText = ""; }
  }
  if (exampleText === undefined) {
    try { exampleText = fs.readFileSync(ENV_EXAMPLE, "utf8"); } catch { exampleText = ""; }
  }
  if (!exampleText) return [];
  const fromEnv = parseEnvText(envText);
  const fromExample = parseEnvText(exampleText);
  return WATCHED_KEYS.filter((key) => {
    const exampleValue = fromExample[key];
    if (looksPlaceholder(exampleValue)) return false;
    // .env 里已有真实环境变量（容器注入也算）就不算写错
    const envValue = fromEnv[key];
    return looksPlaceholder(envValue) && looksPlaceholder(process.env[key]);
  });
}

/**
 * `OD_SKIP_ENV_FILE=1` 时完全不读 .env。
 *
 * 给测试与 CI 用：测试脚本会自己构造完整的子进程环境，如果这时还去读开发机上
 * 那份 `server/.env`，结果就不再只由显式环境变量决定 —— 同一份代码在「有 .env」
 * 和「没 .env」的机器上跑出不同结论，是排查起来最费劲的一类假失败。
 * 三个测试脚本（api-test / gate-test / prod-e2e）都显式带上了这个开关。
 */
const LOADED = process.env.OD_SKIP_ENV_FILE === "1" ? 0 : loadEnvFile(ENV_FILE);

module.exports = {
  loadEnvFile,
  parseEnvText,
  findMisplacedConfig,
  ENV_FILE,
  ENV_EXAMPLE,
  LOADED
};
