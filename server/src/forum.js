"use strict";

/**
 * 论坛：版块、主题、回复、点赞。
 *
 * 与表白墙的分工（这是产品层面的刻意区分，不是实现细节）：
 *   - 表白墙是**匿名广播**：前台不返回任何作者信息，先审后发；
 *   - 论坛是**署名讨论**：每条内容都带昵称/头衔/等级，命中预筛才转人工。
 *
 * 审核口径由 config.FORUM_PREMOD 控制：默认「命中预筛才 pending」，
 * 设为 1 则退化成和表白墙一样的全量先审后发。
 */

const db = require("./db");
const config = require("./config");
const users = require("./users");

/** 版块白名单：版块是产品结构，不是运营数据，所以不建表 */
const BOARDS = [
  { key: "general", name: "综合" },
  { key: "study", name: "学习" },
  { key: "life", name: "生活" },
  { key: "lost", name: "失物" }
];
const BOARD_KEYS = BOARDS.map((b) => b.key);

const TITLE_MIN = 2;
const TITLE_MAX = 60;
const BODY_MAX = 4000;
const REPLY_MAX = 1000;

function cleanBoard(value) {
  const key = String(value || "").trim();
  return BOARD_KEYS.includes(key) ? key : "general";
}

/** 命中预筛 → pending（人工复核）；否则按 FORUM_PREMOD 决定是否直接公开 */
function statusFor(flagged) {
  if (flagged) return "pending";
  return config.FORUM_PREMOD ? "pending" : "approved";
}

function excerpt(body, len = 80) {
  const text = String(body || "").replace(/\s+/g, " ").trim();
  return text.length > len ? text.slice(0, len) + "…" : text;
}

/** 一页主题的完整组装：作者、点赞态都在这里补齐，路由层只负责发 JSON */
function shapeThreads(rows, viewerId) {
  if (!rows.length) return [];
  const authors = users.rowsByIds(rows.map((r) => r.author_id));
  const titles = users.allTitles();

  let likedSet = new Set();
  if (viewerId) {
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    const liked = db.prepare(
      `SELECT thread_id FROM thread_likes WHERE user_id = ? AND thread_id IN (${placeholders})`
    ).all(viewerId, ...ids);
    likedSet = new Set(liked.map((l) => l.thread_id));
  }

  return rows.map((r) => ({
    id: r.id,
    board: r.board,
    title: r.title,
    // 列表只要摘要，详情要全文 —— 两者共用这个组装函数，因此两个字段都给，
    // 由调用方决定用哪个（列表接口不额外查库，body 本来就在行里）。
    body: r.body,
    excerpt: excerpt(r.body),
    author: users.publicUser(authors.get(r.author_id), { titles }),
    replyCount: r.reply_count,
    likeCount: r.like_count,
    viewCount: r.view_count,
    liked: likedSet.has(r.id),
    createdAt: r.created_at,
    lastReplyAt: r.last_reply_at
  }));
}

function shapeReplies(rows) {
  if (!rows.length) return [];
  const authors = users.rowsByIds(rows.map((r) => r.author_id));
  const titles = users.allTitles();
  return rows.map((r) => ({
    id: r.id,
    body: r.body,
    author: users.publicUser(authors.get(r.author_id), { titles }),
    createdAt: r.created_at
  }));
}

/* ───────────────────────────── 读 ───────────────────────────── */

/**
 * 主题列表，keyset 分页。
 * new  : (created_at, id) < (?, ?)
 * hot  : (like_count, id) < (?, ?)  —— 与表白墙同一套游标约定，前端可以复用分页逻辑
 */
function listThreads({ board = "", sort = "new", cursor = "", limit = 20, viewerId = null } = {}) {
  const where = ["status = 'approved'"];
  const args = [];

  const b = String(board || "").trim();
  if (b && BOARD_KEYS.includes(b)) {
    where.push("board = ?");
    args.push(b);
  }

  const take = Math.max(1, Math.min(50, Number(limit) || 20));
  let sql;

  if (sort === "hot") {
    const [likes, id] = String(cursor).split(".");
    const l = Number(likes);
    const i = Number(id);
    if (Number.isFinite(l) && l >= 0 && i > 0) {
      where.push("(like_count, id) < (?, ?)");
      args.push(l, i);
    }
    sql = `SELECT id, board, author_id, title, body, reply_count, like_count, view_count, created_at, last_reply_at
             FROM forum_threads WHERE ${where.join(" AND ")}
            ORDER BY like_count DESC, id DESC LIMIT ?`;
    args.push(take + 1);
  } else {
    const [time, id] = String(cursor).split(".");
    const t = Number(time);
    const i = Number(id);
    if (Number.isFinite(t) && t > 0 && i > 0) {
      where.push("(created_at, id) < (?, ?)");
      args.push(t, i);
    }
    sql = `SELECT id, board, author_id, title, body, reply_count, like_count, view_count, created_at, last_reply_at
             FROM forum_threads WHERE ${where.join(" AND ")}
            ORDER BY created_at DESC, id DESC LIMIT ?`;
    args.push(take + 1);
  }

  const rows = db.prepare(sql).all(...args);
  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;
  const last = page[page.length - 1] || null;

  return {
    items: shapeThreads(page, viewerId),
    nextCursor: hasMore && last
      ? (sort === "hot" ? `${last.like_count}.${last.id}` : `${last.created_at}.${last.id}`)
      : null
  };
}

function getThreadRow(id) {
  return db.prepare(
    `SELECT id, board, author_id, title, body, status, reply_count, like_count, view_count, created_at, last_reply_at
       FROM forum_threads WHERE id = ?`
  ).get(Number(id) || 0) || null;
}

/** 详情：主题 + 第一页回复。浏览量按次累加（单条 UPDATE，代价可忽略）。 */
function getThread(id, viewerId = null) {
  const row = getThreadRow(id);
  if (!row || row.status !== "approved") return null;
  db.prepare("UPDATE forum_threads SET view_count = view_count + 1 WHERE id = ?").run(row.id);

  const replies = db.prepare(
    `SELECT id, author_id, body, created_at FROM forum_replies
      WHERE thread_id = ? AND status = 'approved' ORDER BY id ASC LIMIT 200`
  ).all(row.id);

  const [thread] = shapeThreads([{ ...row, view_count: row.view_count + 1 }], viewerId);
  return { thread, replies: shapeReplies(replies) };
}

function listReplies(threadId, limit = 200) {
  const rows = db.prepare(
    `SELECT id, author_id, body, created_at FROM forum_replies
      WHERE thread_id = ? AND status = 'approved' ORDER BY id ASC LIMIT ?`
  ).all(Number(threadId) || 0, Math.min(500, Number(limit) || 200));
  return shapeReplies(rows);
}

/* ───────────────────────────── 写 ───────────────────────────── */

function createThread({ authorId, board, title, body, mod }) {
  const now = Date.now();
  const flagged = Boolean(mod && mod.flagged);
  const status = statusFor(flagged);
  const info = db.prepare(
    `INSERT INTO forum_threads (board, author_id, title, body, status, flag, reply_count, like_count, view_count, created_at, last_reply_at)
     VALUES (?,?,?,?,?,?,0,0,0,?,?)`
  ).run(cleanBoard(board), authorId, title, body, status, flagged ? mod.flags.join(",") : null, now, now);
  return { id: info.lastInsertRowid, status };
}

function createReply({ threadId, authorId, body, mod }) {
  const now = Date.now();
  const flagged = Boolean(mod && mod.flagged);
  const status = statusFor(flagged);

  const result = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO forum_replies (thread_id, author_id, body, status, flag, created_at)
       VALUES (?,?,?,?,?,?)`
    ).run(threadId, authorId, body, status, flagged ? mod.flags.join(",") : null, now);
    // 计数只统计已公开的回复：待审的回复不该出现在列表的「N 条回复」里
    if (status === "approved") {
      db.prepare("UPDATE forum_threads SET reply_count = reply_count + 1, last_reply_at = ? WHERE id = ?")
        .run(now, threadId);
    }
    return info.lastInsertRowid;
  })();

  return { id: result, status };
}

/** 点赞切换。计数走 like_count 缓存列，与表白墙同一套做法。 */
function toggleLike(threadId, userId) {
  const existing = db.prepare("SELECT 1 AS hit FROM thread_likes WHERE thread_id = ? AND user_id = ?")
    .get(threadId, userId);

  const likes = db.transaction(() => {
    if (existing) {
      db.prepare("DELETE FROM thread_likes WHERE thread_id = ? AND user_id = ?").run(threadId, userId);
      db.prepare("UPDATE forum_threads SET like_count = MAX(0, like_count - 1) WHERE id = ?").run(threadId);
    } else {
      db.prepare("INSERT INTO thread_likes (thread_id, user_id, created_at) VALUES (?,?,?)")
        .run(threadId, userId, Date.now());
      db.prepare("UPDATE forum_threads SET like_count = like_count + 1 WHERE id = ?").run(threadId);
    }
    return db.prepare("SELECT like_count FROM forum_threads WHERE id = ?").get(threadId).like_count;
  })();

  return { liked: !existing, likes };
}

/* ───────────────────────────── 审核 ───────────────────────────── */

function queueThreads({ limit = 50, cursor = 0 } = {}) {
  const lastId = Number(cursor) || 0;
  const rows = db.prepare(
    `SELECT id, board, author_id, title, body, flag, created_at FROM forum_threads
      WHERE status = 'pending' ${lastId > 0 ? "AND id < ?" : ""}
      ORDER BY created_at ASC, id ASC LIMIT ?`
  ).all(...(lastId > 0 ? [lastId] : []), Math.min(100, Number(limit) || 50) + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const authors = users.rowsByIds(page.map((r) => r.author_id));
  const titles = users.allTitles();

  return {
    items: page.map((r) => ({
      id: r.id,
      kind: "thread",
      board: r.board,
      title: r.title,
      body: r.body,
      flag: r.flag || "",
      author: users.publicUser(authors.get(r.author_id), { titles }),
      createdAt: r.created_at
    })),
    nextCursor: hasMore && page.length ? page[page.length - 1].id : null
  };
}

function queueReplies({ limit = 50, cursor = 0 } = {}) {
  const lastId = Number(cursor) || 0;
  const rows = db.prepare(
    `SELECT r.id, r.thread_id, r.author_id, r.body, r.flag, r.created_at, t.title AS thread_title
       FROM forum_replies r LEFT JOIN forum_threads t ON t.id = r.thread_id
      WHERE r.status = 'pending' ${lastId > 0 ? "AND r.id < ?" : ""}
      ORDER BY r.created_at ASC, r.id ASC LIMIT ?`
  ).all(...(lastId > 0 ? [lastId] : []), Math.min(100, Number(limit) || 50) + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const authors = users.rowsByIds(page.map((r) => r.author_id));
  const titles = users.allTitles();

  return {
    items: page.map((r) => ({
      id: r.id,
      kind: "reply",
      threadId: r.thread_id,
      threadTitle: r.thread_title || "",
      body: r.body,
      flag: r.flag || "",
      author: users.publicUser(authors.get(r.author_id), { titles }),
      createdAt: r.created_at
    })),
    nextCursor: hasMore && page.length ? page[page.length - 1].id : null
  };
}

/** 审核动作统一入口：approve 时补经验、补计数；reject/remove 时递减已计入的部分 */
function reviewThread(id, action) {
  const row = db.prepare("SELECT id, author_id, status FROM forum_threads WHERE id = ?").get(Number(id) || 0);
  if (!row) return { ok: false, error: "not_found" };

  const next = action === "approve" ? "approved" : action === "reject" ? "removed" : "removed";
  const wasApproved = row.status === "approved";

  db.transaction(() => {
    db.prepare("UPDATE forum_threads SET status = ? WHERE id = ?").run(next, row.id);
    if (next === "approved" && !wasApproved) users.addExp(row.author_id, users.EXP.thread_created);
  })();

  return { ok: true, status: next };
}

function reviewReply(id, action) {
  const row = db.prepare("SELECT id, thread_id, author_id, status FROM forum_replies WHERE id = ?").get(Number(id) || 0);
  if (!row) return { ok: false, error: "not_found" };

  const next = action === "approve" ? "approved" : "removed";
  const wasApproved = row.status === "approved";

  db.transaction(() => {
    db.prepare("UPDATE forum_replies SET status = ? WHERE id = ?").run(next, row.id);
    if (next === "approved" && !wasApproved) {
      db.prepare("UPDATE forum_threads SET reply_count = reply_count + 1, last_reply_at = ? WHERE id = ?")
        .run(Date.now(), row.thread_id);
      users.addExp(row.author_id, users.EXP.reply_created);
    } else if (next !== "approved" && wasApproved) {
      db.prepare("UPDATE forum_threads SET reply_count = MAX(0, reply_count - 1) WHERE id = ?").run(row.thread_id);
    }
  })();

  return { ok: true, status: next };
}

/** 作者主页用：某人的主题列表 */
function threadsByAuthor(authorId, limit = 20) {
  const rows = db.prepare(
    `SELECT id, board, author_id, title, body, reply_count, like_count, view_count, created_at, last_reply_at
       FROM forum_threads WHERE author_id = ? AND status = 'approved'
      ORDER BY id DESC LIMIT ?`
  ).all(authorId, Math.min(50, Number(limit) || 20));
  return shapeThreads(rows, null);
}

module.exports = {
  BOARDS,
  BOARD_KEYS,
  TITLE_MIN,
  TITLE_MAX,
  BODY_MAX,
  REPLY_MAX,
  cleanBoard,
  listThreads,
  getThread,
  getThreadRow,
  listReplies,
  createThread,
  createReply,
  toggleLike,
  queueThreads,
  queueReplies,
  reviewThread,
  reviewReply,
  threadsByAuthor,
  excerpt
};
