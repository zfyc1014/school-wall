"use strict";

/**
 * 好友与私信。
 *
 * 数据模型：好友关系**只存一行**（requester → addressee），方向由 status 决定语义：
 *   pending  待对方同意
 *   accepted 已是好友（无论谁发起的）
 *   declined 已拒绝（保留行是为了不再反复推荐，用户可以重新发起）
 *   blocked  requester 拉黑了 addressee
 *
 * 这样「互相加好友自动成为好友」（微信/QQ 的行为）就是一次 UPDATE，
 * 而不是插入第二行再想办法去重 —— 后者迟早会出现双向两行不一致的状态。
 */

const db = require("./db");
const users = require("./users");

const DM_MAX = 500;
const FRIEND_MESSAGE_MAX = 60;

/* ───────────────────────────── 关系 ───────────────────────────── */

function rowBetween(aId, bId) {
  return db.prepare(
    `SELECT requester_id, addressee_id, status, message, created_at, updated_at
       FROM friendships
      WHERE (requester_id = ? AND addressee_id = ?)
         OR (requester_id = ? AND addressee_id = ?)
      LIMIT 1`
  ).get(aId, bId, bId, aId) || null;
}

/** 给前端的关系标记：self | none | friend | pending_out | pending_in | blocked | blocked_by */
function relationFor(viewerId, targetId) {
  if (!viewerId) return "none";
  if (viewerId === targetId) return "self";
  const row = rowBetween(viewerId, targetId);
  if (!row) return "none";
  if (row.status === "accepted") return "friend";
  if (row.status === "pending") return row.requester_id === viewerId ? "pending_out" : "pending_in";
  if (row.status === "blocked") return row.requester_id === viewerId ? "blocked" : "blocked_by";
  return "none";
}

function areFriends(aId, bId) {
  const row = rowBetween(aId, bId);
  return Boolean(row && row.status === "accepted");
}

/** 任一方拉黑都不能私信 */
function isBlockedBetween(aId, bId) {
  const row = rowBetween(aId, bId);
  return Boolean(row && row.status === "blocked");
}

/* ───────────────────────────── 好友操作 ───────────────────────────── */

function shapeRequest(row, peerId) {
  const peer = users.findById(peerId);
  return {
    user: users.publicUser(peer),
    message: row.message || "",
    createdAt: row.updated_at || row.created_at
  };
}

function listFriends(userId) {
  const rows = db.prepare(
    `SELECT requester_id, addressee_id, status, message, created_at, updated_at
       FROM friendships
      WHERE (requester_id = ? OR addressee_id = ?) AND status <> 'blocked'
      ORDER BY updated_at DESC`
  ).all(userId, userId);

  const friends = [];
  const incoming = [];
  const outgoing = [];

  for (const row of rows) {
    const peerId = row.requester_id === userId ? row.addressee_id : row.requester_id;
    if (row.status === "accepted") friends.push(shapeRequest(row, peerId));
    else if (row.status === "pending" && row.addressee_id === userId) incoming.push(shapeRequest(row, peerId));
    else if (row.status === "pending" && row.requester_id === userId) outgoing.push(shapeRequest(row, peerId));
  }

  return { friends, incoming, outgoing };
}

/**
 * 发起好友请求。
 * 对方已经向我发过请求时直接成为好友 —— 这是「互相添加」的核心体验，
 * 也是微信/QQ 与「单向关注」最直观的区别。
 */
function sendRequest(fromId, toUuid, message = "") {
  const target = users.findByUuid(toUuid);
  if (!target) return { ok: false, error: "not_found" };
  if (target.id === fromId) return { ok: false, error: "self" };

  const row = rowBetween(fromId, target.id);
  const now = Date.now();
  const msg = String(message || "").trim().slice(0, FRIEND_MESSAGE_MAX);

  if (row && row.status === "accepted") return { ok: false, error: "already_friends" };
  if (row && row.status === "blocked") return { ok: false, error: "blocked" };

  if (row && row.status === "pending") {
    if (row.requester_id === target.id) {
      // 对方先发的 → 我这一下等于「同意」
      db.prepare("UPDATE friendships SET status = 'accepted', updated_at = ? WHERE requester_id = ? AND addressee_id = ?")
        .run(now, target.id, fromId);
      return { ok: true, status: "accepted" };
    }
    return { ok: true, status: "pending", duplicated: true };
  }

  if (row) {
    // declined：允许重新发起，复用同一行（主键就是这对用户）
    db.prepare(
      `UPDATE friendships SET requester_id = ?, addressee_id = ?, status = 'pending', message = ?, updated_at = ?
        WHERE requester_id = ? AND addressee_id = ?`
    ).run(fromId, target.id, msg || null, now, row.requester_id, row.addressee_id);
    return { ok: true, status: "pending" };
  }

  db.prepare(
    "INSERT INTO friendships (requester_id, addressee_id, status, message, created_at, updated_at) VALUES (?,?,?,?,?,?)"
  ).run(fromId, target.id, "pending", msg || null, now, now);
  return { ok: true, status: "pending" };
}

function acceptRequest(userId, requesterUuid) {
  const requester = users.findByUuid(requesterUuid);
  if (!requester) return { ok: false, error: "not_found" };
  const info = db.prepare(
    "UPDATE friendships SET status = 'accepted', updated_at = ? WHERE requester_id = ? AND addressee_id = ? AND status = 'pending'"
  ).run(Date.now(), requester.id, userId);
  if (!info.changes) return { ok: false, error: "no_request" };
  return { ok: true };
}

function declineRequest(userId, requesterUuid) {
  const requester = users.findByUuid(requesterUuid);
  if (!requester) return { ok: false, error: "not_found" };
  const info = db.prepare(
    "UPDATE friendships SET status = 'declined', updated_at = ? WHERE requester_id = ? AND addressee_id = ? AND status = 'pending'"
  ).run(Date.now(), requester.id, userId);
  if (!info.changes) return { ok: false, error: "no_request" };
  return { ok: true };
}

/**
 * 撤回自己**发出、对方还没处理**的好友请求。
 *
 * 之前只能等对方操作：发给一个不想加的人是撤回不了的，请求就永久挂在那里。
 * 只允许删「我发起的 + 仍是 pending」的行，别人的请求或已成立的好友关系都动不了。
 */
function cancelRequest(userId, peerUuid) {
  const peer = users.findByUuid(peerUuid);
  if (!peer) return { ok: false, error: "not_found" };
  const info = db.prepare(
    "DELETE FROM friendships WHERE status = 'pending' AND requester_id = ? AND addressee_id = ?"
  ).run(userId, peer.id);
  return { ok: info.changes > 0, error: info.changes ? undefined : "no_pending_request" };
}

/** 删除好友：直接删行（聊天记录保留，重新加回来还能看到历史） */
function removeFriend(userId, peerUuid) {
  const peer = users.findByUuid(peerUuid);
  if (!peer) return { ok: false, error: "not_found" };
  db.prepare(
    `DELETE FROM friendships
      WHERE status = 'accepted'
        AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))`
  ).run(userId, peer.id, peer.id, userId);
  return { ok: true };
}

/** 拉黑：解除好友 + 把关系行改写为 blocked（方向固定为「我 → 对方」） */
function blockUser(userId, peerUuid) {
  const peer = users.findByUuid(peerUuid);
  if (!peer) return { ok: false, error: "not_found" };
  if (peer.id === userId) return { ok: false, error: "self" };

  db.transaction(() => {
    db.prepare(
      "DELETE FROM friendships WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)"
    ).run(userId, peer.id, peer.id, userId);
    db.prepare(
      "INSERT INTO friendships (requester_id, addressee_id, status, created_at, updated_at) VALUES (?,?,'blocked',?,?)"
    ).run(userId, peer.id, Date.now(), Date.now());
  })();
  return { ok: true };
}

function unblockUser(userId, peerUuid) {
  const peer = users.findByUuid(peerUuid);
  if (!peer) return { ok: false, error: "not_found" };
  db.prepare("DELETE FROM friendships WHERE requester_id = ? AND addressee_id = ? AND status = 'blocked'")
    .run(userId, peer.id);
  return { ok: true };
}

/* ───────────────────────────── 私信 ───────────────────────────── */

function canMessage(fromId, toId) {
  if (isBlockedBetween(fromId, toId)) return { ok: false, error: "blocked" };
  if (!areFriends(fromId, toId)) return { ok: false, error: "not_friends" };
  return { ok: true };
}

function sendMessage(fromId, toUuid, body) {
  const target = users.findByUuid(toUuid);
  if (!target) return { ok: false, error: "not_found" };
  if (target.id === fromId) return { ok: false, error: "self" };
  if (target.status === "banned") return { ok: false, error: "not_found" };

  const allowed = canMessage(fromId, target.id);
  if (!allowed.ok) return allowed;

  const text = String(body == null ? "" : body).trim();
  if (!text.length) return { ok: false, error: "empty" };
  if (text.length > DM_MAX) return { ok: false, error: "too_long" };

  const now = Date.now();
  const info = db.prepare(
    "INSERT INTO dm_messages (sender_id, recipient_id, body, created_at) VALUES (?,?,?,?)"
  ).run(fromId, target.id, text, now);

  return { ok: true, id: info.lastInsertRowid, createdAt: now };
}

/** 会话列表：以「最近一条消息」排序，附未读数 */
function conversations(userId, limit = 50) {
  const rows = db.prepare(
    `SELECT peer, MAX(id) AS last_id FROM (
         SELECT recipient_id AS peer, id FROM dm_messages WHERE sender_id = ?
         UNION ALL
         SELECT sender_id AS peer, id FROM dm_messages WHERE recipient_id = ?
       ) GROUP BY peer ORDER BY last_id DESC LIMIT ?`
  ).all(userId, userId, Math.min(100, Number(limit) || 50));

  if (!rows.length) return { items: [], unread: 0 };

  const ids = rows.map((r) => r.last_id);
  const peers = rows.map((r) => r.peer);
  const placeholders = ids.map(() => "?").join(",");

  const messages = db.prepare(
    `SELECT id, sender_id, recipient_id, body, created_at FROM dm_messages WHERE id IN (${placeholders})`
  ).all(...ids);
  const byId = new Map(messages.map((m) => [m.id, m]));

  const unreadRows = db.prepare(
    `SELECT sender_id, COUNT(*) AS n FROM dm_messages
      WHERE recipient_id = ? AND read_at IS NULL GROUP BY sender_id`
  ).all(userId);
  const unreadMap = new Map(unreadRows.map((r) => [r.sender_id, r.n]));

  const userRows = users.rowsByIds(peers);
  const titles = users.allTitles();

  let total = 0;
  const items = rows.map((r) => {
    const last = byId.get(r.last_id);
    const unread = unreadMap.get(r.peer) || 0;
    total += unread;
    return {
      peer: users.publicUser(userRows.get(r.peer), { titles }),
      last: last ? { body: last.body, createdAt: last.created_at, mine: last.sender_id === userId } : null,
      unread
    };
  }).filter((item) => item.peer);

  return { items, unread: total };
}

/** 单聊记录：按 id 倒序 keyset 翻页，返回时反转成时间正序方便直接渲染 */
function threadWith(userId, peerUuid, { cursor = "", limit = 30 } = {}) {
  const peer = users.findByUuid(peerUuid);
  if (!peer) return { ok: false, error: "not_found" };

  const take = Math.max(1, Math.min(100, Number(limit) || 30));
  const lastId = Number(cursor) || 0;

  const rows = db.prepare(
    `SELECT id, sender_id, recipient_id, body, read_at, created_at FROM dm_messages
      WHERE ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))
        ${lastId > 0 ? "AND id < ?" : ""}
      ORDER BY id DESC LIMIT ?`
  ).all(...(lastId > 0 ? [userId, peer.id, peer.id, userId, lastId, take + 1] : [userId, peer.id, peer.id, userId, take + 1]));

  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;

  // 打开会话即视为已读：只更新对方发给我的未读
  db.prepare(
    "UPDATE dm_messages SET read_at = ? WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL"
  ).run(Date.now(), peer.id, userId);

  return {
    ok: true,
    peer: users.publicUser(peer),
    items: page.slice().reverse().map((m) => ({
      id: m.id,
      body: m.body,
      mine: m.sender_id === userId,
      createdAt: m.created_at
    })),
    nextCursor: hasMore && page.length ? page[page.length - 1].id : null
  };
}

function unreadCount(userId) {
  const row = db.prepare(
    "SELECT COUNT(*) AS n FROM dm_messages WHERE recipient_id = ? AND read_at IS NULL"
  ).get(userId);
  return row ? row.n : 0;
}

/** 后台：某人最近的私信往来（只给管理员看元数据，正文只在详情页按需取） */
function recentMessagesFor(userId, limit = 20) {
  return db.prepare(
    `SELECT id, sender_id, recipient_id, body, created_at FROM dm_messages
      WHERE sender_id = ? OR recipient_id = ? ORDER BY id DESC LIMIT ?`
  ).all(userId, userId, Math.min(50, Number(limit) || 20));
}

module.exports = {
  DM_MAX,
  rowBetween,
  relationFor,
  areFriends,
  isBlockedBetween,
  listFriends,
  sendRequest,
  acceptRequest,
  declineRequest,
  cancelRequest,
  removeFriend,
  blockUser,
  unblockUser,
  canMessage,
  sendMessage,
  conversations,
  threadWith,
  unreadCount,
  recentMessagesFor
};
