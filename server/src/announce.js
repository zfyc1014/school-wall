"use strict";

/**
 * 首页公告栏。
 *
 * 全部由后台维护：运营改一条公告不需要改代码、不需要重新构建前端，
 * 前端只通过 GET /api/site 拿启用中的公告。
 *
 * 读多写极少，因此这里做一层内存缓存（后台写操作会立即失效），
 * 避免每次刷新首页都打一次数据库。
 */

const db = require("./db");

let cache = null;

function bump() {
  cache = null;
}

/** 前台：启用中的公告，按 sort 升序、新公告在前 */
function listActive() {
  if (cache) return cache;
  const rows = db.prepare(
    "SELECT id, body, link, link_text FROM announcements WHERE active = 1 ORDER BY sort ASC, id DESC LIMIT 5"
  ).all();
  cache = rows.map((r) => ({
    id: r.id,
    body: r.body,
    link: r.link || "",
    linkText: r.link_text || ""
  }));
  return cache;
}

/** 后台：全部公告（含已下线） */
function listAll() {
  return db.prepare(
    "SELECT id, body, link, link_text, active, sort, created_at, updated_at FROM announcements ORDER BY sort ASC, id DESC"
  ).all().map((r) => ({
    id: r.id,
    body: r.body,
    link: r.link || "",
    linkText: r.link_text || "",
    active: Boolean(r.active),
    sort: r.sort,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }));
}

const BODY_MAX = 120;

function create({ body, link = "", linkText = "", sort = 0, active = true }) {
  const text = String(body || "").replace(/\s+/g, " ").trim();
  if (!text) return { ok: false, error: "empty" };
  if (text.length > BODY_MAX) return { ok: false, error: "too_long" };
  const now = Date.now();
  const info = db.prepare(
    `INSERT INTO announcements (body, link, link_text, active, sort, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run(text, normalizeLink(link), String(linkText || "").trim().slice(0, 12), active ? 1 : 0, Number(sort) || 0, now, now);
  bump();
  return { ok: true, id: info.lastInsertRowid };
}

function update(id, patch) {
  const row = db.prepare("SELECT id FROM announcements WHERE id = ?").get(Number(id) || 0);
  if (!row) return { ok: false, error: "not_found" };

  const sets = [];
  const args = [];

  if (Object.prototype.hasOwnProperty.call(patch, "body")) {
    const text = String(patch.body || "").replace(/\s+/g, " ").trim();
    if (!text) return { ok: false, error: "empty" };
    if (text.length > BODY_MAX) return { ok: false, error: "too_long" };
    sets.push("body = ?");
    args.push(text);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "link")) {
    sets.push("link = ?");
    args.push(normalizeLink(patch.link));
  }
  if (Object.prototype.hasOwnProperty.call(patch, "linkText")) {
    sets.push("link_text = ?");
    args.push(String(patch.linkText || "").trim().slice(0, 12));
  }
  if (Object.prototype.hasOwnProperty.call(patch, "active")) {
    sets.push("active = ?");
    args.push(patch.active ? 1 : 0);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "sort")) {
    sets.push("sort = ?");
    args.push(Number(patch.sort) || 0);
  }
  if (!sets.length) return { ok: true, unchanged: true };

  sets.push("updated_at = ?");
  args.push(Date.now(), row.id);
  db.prepare(`UPDATE announcements SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  bump();
  return { ok: true };
}

function remove(id) {
  const info = db.prepare("DELETE FROM announcements WHERE id = ?").run(Number(id) || 0);
  if (!info.changes) return { ok: false, error: "not_found" };
  bump();
  return { ok: true };
}

/** 只允许站内相对路径或 https 链接：后台是受信输入，但仍不该写出 javascript: 这种值 */
function normalizeLink(raw) {
  const link = String(raw == null ? "" : raw).trim().slice(0, 200);
  if (!link) return "";
  if (link.startsWith("#/")) return link;
  if (link.startsWith("/")) return link;
  if (/^https:\/\//i.test(link)) return link;
  return "";
}

module.exports = { listActive, listAll, create, update, remove, bump, BODY_MAX };
