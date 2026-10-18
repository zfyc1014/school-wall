"use strict";

/**
 * 站点页面（目前只有首页）。
 *
 * 首页是一整块 **Markdown**，由后台编辑、公开只读。为什么不复用公告/帖子：
 *   - 公告是「一条条短消息」，首页是「一整页排版」；
 *   - 帖子要经过审核/计数/点赞，首页不该背这些语义。
 * 所以单独一张 site_pages 表：整块替换、带更新时间与最后编辑人。
 */

const config = require("./config");
const db = require("./db");

/** 首页内容长度上限：够写一整篇介绍，又不至于把请求体顶爆 */
const MAX_MD = 200 * 1024;

function getPage(key) {
  const row = db.prepare("SELECT body, updated_at, updated_by FROM site_pages WHERE key = ?").get(String(key));
  return row ? { body: row.body || "", updatedAt: row.updated_at || 0, updatedBy: row.updated_by || "" } : { body: "", updatedAt: 0, updatedBy: "" };
}

function setPage(key, body) {
  const text = String(body == null ? "" : body);
  if (text.length > MAX_MD) return { ok: false, error: "too_long" };
  const now = Date.now();
  db.prepare(
    `INSERT INTO site_pages (key, body, updated_at, updated_by) VALUES (?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  ).run(String(key), text, now, "admin");
  return { ok: true, updatedAt: now };
}

/** 首页默认内容：空态也要有东西可看，而不是一片空白 */
const DEFAULT_HOME = [
  "## 欢迎来到 " + config.SITE_NAME,
  "",
  "这里是校园墙的首页，由站方编辑。",
  "",
  "> 还没有内容 —— 管理员可以到后台「首页」里写点什么。"
].join("\n");

function homeMarkdown() {
  const page = getPage("home");
  return page.body && page.body.trim() ? page.body : DEFAULT_HOME;
}

module.exports = { MAX_MD, getPage, setPage, homeMarkdown, DEFAULT_HOME };
