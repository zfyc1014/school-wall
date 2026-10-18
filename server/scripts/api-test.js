"use strict";

/**
 * 后端 API 全链路测试（v1.0.0）。
 *
 * 为什么是「一条龙」而不是按接口分散：
 *   本站接口是有状态的 —— 必须真注册账号、真发帖、真加好友，才能验证权限、
 *   计数、审核口径这些最容易写错的地方。用 mock 数据测不出这些。
 *
 * 做法：起一个真实服务进程（临时库 + 临时端口 + AUTH_CODE_ECHO），
 * 用真实 HTTP 请求走完整流程，逐条断言；跑完删库、杀进程。
 *
 * 用法：node scripts/api-test.js
 */

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PORT = 8300 + Math.floor(Math.random() * 200);
const BASE = "http://127.0.0.1:" + PORT;
const ADMIN_TOKEN = "test-admin-token-0123456789abcdef";
const IP_SECRET = "test-ip-hash-secret-0123456789abcdef";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "wall-api-"));
const DB_PATH = path.join(TMP, "test.db");
const OUTBOX = path.join(TMP, "outbox");
const BANNED = path.join(TMP, "banned.txt");

// 测试词表只放一个自造词：这样断言不依赖真实词库的内容（词库是可以被运营替换的）
fs.writeFileSync(BANNED, "# 测试词表\n测试违禁词\n", "utf8");

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log("  ✓ " + name);
  } else {
    failed += 1;
    failures.push(name);
    console.log("  ✗ " + name + (detail === undefined ? "" : "  → " + JSON.stringify(detail)));
  }
}

const eq = (name, actual, expected) => ok(name, actual === expected, { actual, expected });
const section = (title) => console.log("\n" + title);

/* ───────────────────────── HTTP 客户端（带 cookie jar）───────────────────────── */

function createClient() {
  const jar = new Map();

  async function request(method, url, { body, admin = false } = {}) {
    const headers = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (admin) headers.authorization = "Bearer " + ADMIN_TOKEN;
    if (jar.size) headers.cookie = Array.from(jar).map(([k, v]) => k + "=" + v).join("; ");

    const res = await fetch(BASE + url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const line of setCookies) {
      const pair = line.split(";")[0];
      const idx = pair.indexOf("=");
      if (idx < 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (!value || /Max-Age=0/i.test(line)) jar.delete(name);
      else jar.set(name, value);
    }

    const text = await res.text();
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
    }
    return { status: res.status, body: payload };
  }

  return {
    get: (url, o) => request("GET", url, o),
    post: (url, body, o = {}) => request("POST", url, { ...o, body: body === undefined ? {} : body }),
    patch: (url, body, o) => request("PATCH", url, { ...o, body }),
    del: (url, o) => request("DELETE", url, o),
    jar
  };
}

/* ───────────────────────── 服务进程 ───────────────────────── */

const server = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], {
  cwd: ROOT,
  env: {
    ...process.env,
    OD_SKIP_ENV_FILE: "1",
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: String(PORT),
    DB_PATH,
    OUTBOX_DIR: OUTBOX,
    BANNED_FILE: BANNED,
    ADMIN_TOKEN,
    IP_HASH_SECRET: IP_SECRET,
    AUTH_CODE_ECHO: "1",
    FORCE_HTTPS: "0",
    FEED_CACHE_MS: "0"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let serverLog = "";
server.stdout.on("data", (c) => { serverLog += String(c); });
server.stderr.on("data", (c) => { serverLog += String(c); });

function cleanup() {
  try { server.kill(); } catch { /* ignore */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}

async function waitForServer() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE + "/api/health");
      if (res.ok) return;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("服务未能在 20 秒内启动\n" + serverLog);
}

/** 发码 → 校验 → 注册，返回 { user } 或 { error } */
async function registerUser(client, email, nickname, school) {
  const code = await client.post("/api/auth/code", { email });
  if (code.status !== 200) return { error: code };
  const verified = await client.post("/api/auth/verify", { email, code: code.body.devCode });
  if (verified.status !== 200) return { error: verified };
  const registered = await client.post("/api/auth/register", {
    token: verified.body.token, nickname, school
  });
  return { status: registered.status, user: registered.body.user, body: registered.body };
}

/* ───────────────────────────── 用例 ───────────────────────────── */

async function main() {
  await waitForServer();

  const anon = createClient();
  const alice = createClient();
  const bob = createClient();
  const carol = createClient();
  const dave = createClient();

  let aliceUuid = "";
  let bobUuid = "";
  let threadId = 0;
  let postId = 0;

  section("站点与健康检查");
  {
    const health = await anon.get("/api/health");
    eq("GET /api/health 返回 200", health.status, 200);
    eq("版本号是 1.0.1", health.body.version, "1.0.1");

    const site = await anon.get("/api/site");
    eq("GET /api/site 返回 200", site.status, 200);
    ok("站点信息含 version/siteName/features/announcements",
      Boolean(site.body.version && site.body.siteName && site.body.features && Array.isArray(site.body.announcements)),
      site.body);

    const schools = await anon.get("/api/schools");
    ok("学校名单初始为空（由后台维护）", Array.isArray(schools.body.items) && schools.body.items.length === 0);
  }

  section("后台：学校管理");
  {
    eq("未带令牌访问后台被拒", (await anon.get("/api/admin/users")).status, 401);
    eq("新增学校返回 201", (await anon.post("/api/admin/schools", { name: "示例大学", sort: 1 }, { admin: true })).status, 201);
    await anon.post("/api/admin/schools", { name: "第二大学" }, { admin: true });
    eq("同名学校被拒绝", (await anon.post("/api/admin/schools", { name: "示例大学" }, { admin: true })).body.error, "duplicate_name");
    eq("公开学校列表返回 2 所", (await anon.get("/api/schools")).body.items.length, 2);
  }

  section("注册：邮箱验证码 + 强制选学校 + 昵称预审");
  {
    eq("非法邮箱被拒", (await alice.post("/api/auth/code", { email: "not-an-email" })).status, 400);

    const code = await alice.post("/api/auth/code", { email: "alice@example.com" });
    eq("发送验证码成功", code.status, 200);
    ok("验证码是 6 位数字", /^\d{6}$/.test(code.body.devCode || ""), code.body);
    eq("60 秒内重复发码被限流", (await alice.post("/api/auth/code", { email: "alice@example.com" })).status, 429);

    const wrong = await alice.post("/api/auth/verify", { email: "alice@example.com", code: "000000" });
    ok("错误验证码被拒", wrong.status === 401, wrong.body);

    const verified = await alice.post("/api/auth/verify", { email: "alice@example.com", code: code.body.devCode });
    eq("验证通过且要求补资料", verified.body.needProfile, true);
    const token = verified.body.token;

    eq("不在名单里的学校被拒",
      (await alice.post("/api/auth/register", { token, nickname: "小满", school: "野鸡大学" })).body.error,
      "invalid_school");

    const registered = await alice.post("/api/auth/register", { token, nickname: "小满", school: "示例大学" });
    eq("注册成功", registered.status, 201);
    aliceUuid = registered.body.user.uuid;
    ok("uuid 由服务端生成且是标准 UUID", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(aliceUuid), aliceUuid);
    eq("学校写入了资料", registered.body.user.school, "示例大学");
    eq("新用户等级为 1", registered.body.user.level, 1);
    ok("注册响应带会话 cookie", alice.jar.size > 0, Array.from(alice.jar.keys()));

    const me = await alice.get("/api/auth/me");
    eq("会话生效", me.body.user && me.body.user.nickname, "小满");
    eq("本人可见邮箱", me.body.user.email, "alice@example.com");

    eq("注册令牌一次性（重放被拒）",
      (await carol.post("/api/auth/register", { token, nickname: "重放", school: "示例大学" })).body.error,
      "invalid_token");
  }

  section("昵称预审：冒名与违禁词直接拒绝");
  {
    const code = await carol.post("/api/auth/code", { email: "carol@example.com" });
    const verified = await carol.post("/api/auth/verify", { email: "carol@example.com", code: code.body.devCode });
    const t = verified.body.token;

    eq("冒充管理员被拒",
      (await carol.post("/api/auth/register", { token: t, nickname: "管理员小助手", school: "示例大学" })).body.error,
      "nickname_rejected");
    eq("命中词表被拒",
      (await carol.post("/api/auth/register", { token: t, nickname: "测试违禁词甲", school: "示例大学" })).body.error,
      "nickname_rejected");
    eq("过短昵称被拒",
      (await carol.post("/api/auth/register", { token: t, nickname: "甲", school: "示例大学" })).body.error,
      "nickname_length");
    eq("昵称里塞手机号被拒",
      (await carol.post("/api/auth/register", { token: t, nickname: "联系13800138000", school: "示例大学" })).body.error,
      "nickname_rejected");

    const carolOk = await carol.post("/api/auth/register", { token: t, nickname: "卡罗", school: "示例大学" });
    eq("被拒几次后换个正常昵称仍可注册（令牌没被提前作废）", carolOk.status, 201);

    const daveResult = await registerUser(dave, "dave@example.com", "戴夫", "示例大学");
    eq("换个正常昵称就能注册", daveResult.status, 201);
  }

  section("第二个账号");
  {
    const result = await registerUser(bob, "bob@example.com", "阿波", "示例大学");
    eq("注册成功", result.status, 201);
    bobUuid = result.user.uuid;
    ok("两个账号 uuid 不同", aliceUuid !== bobUuid);
  }

  section("表白墙：匿名、过词库即发布、字数不限");
  {
    eq("未登录发帖被拒", (await anon.post("/api/posts", { cat: "表白", body: "未登录也想发" })).status, 401);

    const longBody = "这是一条很长的表白，".repeat(200); // 2000 字，远超旧版的 500 字上限
    const created = await alice.post("/api/posts", { cat: "表白", body: longBody });
    eq("超长正文可以发布（已取消字数限制）", created.status, 201);
    eq("干净内容直接发布（不排队等人审）", created.body.status, "approved");

    eq("空内容被拒", (await alice.post("/api/posts", { cat: "表白", body: "   " })).body.error, "empty");
    eq("非法分类被 400", (await alice.post("/api/posts", { cat: "不存在的分类", body: "内容" })).status, 400);
    eq("发布后立刻出现在信息流里", (await anon.get("/api/posts")).body.items.length, 1);

    const queue = await anon.get("/api/admin/queue?type=posts", { admin: true });
    eq("干净内容不进后台队列", queue.body.items.length, 0);
    const feed = await anon.get("/api/posts");
    postId = feed.body.items[0].id;
    const item = feed.body.items[0];
    ok("信息流不返回任何作者字段",
      !("nickname" in item) && !("user" in item) && !("uuid" in item) && !("userId" in item),
      Object.keys(item));
    ok("超长正文完整返回（未截断）", String(item.body).length === longBody.length, { got: String(item.body).length });

    eq("未登录不能点赞", (await anon.post("/api/posts/" + postId + "/like", {})).status, 401);
    eq("点赞成功", (await alice.post("/api/posts/" + postId + "/like", {})).body.liked, true);
    eq("再点一次取消（按用户去重）", (await alice.post("/api/posts/" + postId + "/like", {})).body.liked, false);
    eq("第三次又点赞且计数为 1", (await alice.post("/api/posts/" + postId + "/like", {})).body.likes, 1);

    eq("评论同样直接发布", (await alice.post("/api/posts/" + postId + "/comments", { body: "加油" })).body.status, "approved");
    eq("评论立刻可见", (await anon.get("/api/posts/" + postId + "/comments")).body.items.length, 1);

    const cQueue = await anon.get("/api/admin/queue?type=comments", { admin: true });
    eq("干净评论不进后台队列", cQueue.body.items.length, 0);
    eq("帖子评论数已累加", (await anon.get("/api/posts")).body.items[0].comments, 1);

    eq("登录用户可以举报", (await bob.post("/api/reports", { postId, reason: "测试举报" })).status, 201);
  }

  section("论坛：署名讨论（昵称 / 学校 / 头衔 / 等级）");
  {
    const created = await bob.post("/api/forum/threads", {
      board: "study", title: "期末复习资料共享", body: "大家把笔记发到这里吧"
    });
    eq("发主题成功", created.status, 201);
    eq("正常内容直接公开（命中预筛才转人工）", created.body.status, "approved");
    threadId = created.body.id;

    const detail = await alice.get("/api/forum/threads/" + threadId);
    eq("主题详情可读（无需登录）", detail.status, 200);
    eq("主题带作者昵称", detail.body.thread.author.nickname, "阿波");
    eq("主题带作者学校", detail.body.thread.author.school, "示例大学");
    ok("作者对象含等级", typeof detail.body.thread.author.level === "number");
    ok("作者对象含头衔字段", "title" in detail.body.thread.author);

    eq("回复成功且直接公开",
      (await alice.post("/api/forum/threads/" + threadId + "/replies", { body: "我有高数笔记" })).body.status,
      "approved");

    const detail2 = await alice.get("/api/forum/threads/" + threadId);
    eq("回复计数累加", detail2.body.thread.replyCount, 1);
    eq("回复带作者昵称", detail2.body.replies[0].author.nickname, "小满");
    ok("浏览数已累加", detail2.body.thread.viewCount >= 1);

    eq("主题点赞成功", (await alice.post("/api/forum/threads/" + threadId + "/like", {})).body.liked, true);
    eq("详情里带「我点过赞」标记", (await alice.get("/api/forum/threads/" + threadId)).body.thread.liked, true);

    const list = await anon.get("/api/forum/threads?board=study");
    eq("版块筛选返回该主题", list.body.items.length, 1);
    ok("列表带版块清单", Array.isArray(list.body.boards) && list.body.boards.length >= 4);
    ok("列表项带作者信息（署名）", list.body.items[0].author && list.body.items[0].author.nickname === "阿波");

    eq("过短标题被拒", (await bob.post("/api/forum/threads", { board: "study", title: "短", body: "内容" })).body.error, "invalid_title");
    eq("不存在的主题返回 404", (await anon.get("/api/forum/threads/99999")).status, 404);
    eq("未登录不能发主题", (await anon.post("/api/forum/threads", { board: "study", title: "标题", body: "内容" })).status, 401);
  }

  section("好友：请求 / 同意 / 互相添加");
  {
    eq("未登录访问好友列表被拒", (await anon.get("/api/friends")).status, 401);

    eq("发起好友请求", (await alice.post("/api/friends/requests", { uuid: bobUuid, message: "同班同学" })).body.status, "pending");
    eq("不能加自己", (await alice.post("/api/friends/requests", { uuid: aliceUuid })).body.error, "self");

    const bobFriends = await bob.get("/api/friends");
    eq("对方能看到待处理请求", bobFriends.body.incoming.length, 1);
    eq("请求带留言", bobFriends.body.incoming[0].message, "同班同学");

    const aliceFriends0 = await alice.get("/api/friends");
    eq("发起方看到「等待验证」", aliceFriends0.body.outgoing.length, 1);
    eq("此时还不是好友", aliceFriends0.body.friends.length, 0);

    eq("同意请求", (await bob.post("/api/friends/requests/" + aliceUuid + "/accept", {})).status, 200);
    const aliceFriends = await alice.get("/api/friends");
    eq("双方都成为好友", aliceFriends.body.friends.length, 1);
    eq("好友对象带学校", aliceFriends.body.friends[0].user.school, "示例大学");

    eq("重复添加提示已经是好友", (await alice.post("/api/friends/requests", { uuid: bobUuid })).body.error, "already_friends");
    eq("陌生人（卡罗）看主页的关系是 none", (await carol.get("/api/users/" + bobUuid)).body.relation, "none");
    eq("好友看主页的关系是 friend", (await alice.get("/api/users/" + bobUuid)).body.relation, "friend");

    // 反方向：bob 先对 dave 发起，dave 再对 bob 发起 → 直接成为好友（微信/QQ 的「互相添加」）
    const daveUuid = (await dave.get("/api/auth/me")).body.user.uuid;
    await bob.post("/api/friends/requests", { uuid: daveUuid });
    const mutual = await dave.post("/api/friends/requests", { uuid: bobUuid });
    // 撤回：自己发出的、对方还没处理的请求可以收回（否则发错人只能等对方点拒绝）
    eq("发起一条可撤回的请求", (await carol.post("/api/friends/requests", { uuid: daveUuid })).body.status, "pending");
    eq("对方能看到", (await dave.get("/api/friends")).body.incoming.length >= 1, true);
    eq("本人撤回成功", (await carol.del("/api/friends/requests/" + daveUuid)).status, 200);
    eq("撤回后对方列表里没了", (await dave.get("/api/friends")).body.incoming.length, 0);
    eq("重复撤回报错", (await carol.del("/api/friends/requests/" + daveUuid)).status, 400);

    eq("对方已发过请求时，我这边一按即成为好友", mutual.body.status, "accepted");
    eq("双方好友数都 +1", (await bob.get("/api/friends")).body.friends.length, 2);
  }

  section("私信：仅好友可发");
  {
    eq("非好友不能私信", (await carol.post("/api/dm/" + bobUuid, { body: "你好" })).status, 403);

    eq("好友之间可以私信", (await alice.post("/api/dm/" + bobUuid, { body: "笔记发我一份呗" })).status, 201);

    const conv = await bob.get("/api/dm/conversations");
    eq("会话列表显示未读 1", conv.body.unread, 1);
    eq("会话对方昵称正确", conv.body.items[0].peer.nickname, "小满");
    eq("最后一条消息带 mine 标记", conv.body.items[0].last.mine, false);
    eq("未读数接口", (await bob.get("/api/dm/unread")).body.count, 1);

    const thread = await bob.get("/api/dm/" + aliceUuid);
    eq("拉到聊天记录", thread.body.items.length, 1);
    eq("记录里标记了对方发的", thread.body.items[0].mine, false);
    eq("记录带对方资料", thread.body.peer.nickname, "小满");
    eq("打开会话即已读", (await bob.get("/api/dm/unread")).body.count, 0);
  }

  section("拉黑：解除好友 + 拒收私信");
  {
    eq("拉黑成功", (await alice.post("/api/users/" + bobUuid + "/block", {})).status, 200);
    eq("拉黑后好友关系解除", (await alice.get("/api/friends")).body.friends.length, 0);
    eq("拉黑后不能私信", (await alice.post("/api/dm/" + bobUuid, { body: "还能发吗" })).status, 403);
    eq("被拉黑方看到 blocked_by", (await bob.get("/api/users/" + aliceUuid)).body.relation, "blocked_by");
    await alice.post("/api/users/" + bobUuid + "/unblock", {});
    eq("解除拉黑后关系回到 none", (await alice.get("/api/users/" + bobUuid)).body.relation, "none");
  }

  section("账号个性化：学校不可改");
  {
    const updated = await alice.patch("/api/me", { bio: "喜欢在图书馆四楼靠窗", avatar: "leaf" });
    eq("修改简介与头像成功", updated.status, 200);
    eq("头像已保存", updated.body.user.avatar, "leaf");
    eq("改学校无效（该字段被忽略）", (await alice.patch("/api/me", { school: "第二大学" })).body.user.school, "示例大学");
    eq("非法头像被拒", (await alice.patch("/api/me", { avatar: "不存在的头像" })).body.error, "invalid_avatar");
    eq("首次改昵称不被冷却拦住", (await alice.patch("/api/me", { nickname: "小满满" })).status, 200);
    eq("紧接着再改就撞上冷却", (await alice.patch("/api/me", { nickname: "小满满满" })).body.error, "nickname_cooldown");
    eq("简介超长被拒", (await alice.patch("/api/me", { bio: "字".repeat(80) })).body.error, "bio_too_long");
  }

  section("头衔与等级");
  {
    const created = await anon.post("/api/admin/titles", {
      name: "学长", color: "#0071e3", minLevel: 1, auto: true, sort: 1
    }, { admin: true });
    eq("后台新建头衔", created.status, 201);

    const me = await alice.get("/api/auth/me");
    eq("达到条件自动获得头衔", me.body.user.title && me.body.user.title.name, "学长");
    eq("头衔带自定义颜色", me.body.user.title.color, "#0071e3");

    const manual = await anon.post("/api/admin/titles", { name: "版主", minLevel: 1, auto: false }, { admin: true });
    await anon.post("/api/admin/users/1", { action: "set_title", value: manual.body.id }, { admin: true });
    eq("手动指定优先于自动头衔", (await alice.get("/api/auth/me")).body.user.title.name, "版主");

    eq("重名头衔被拒", (await anon.post("/api/admin/titles", { name: "版主" }, { admin: true })).body.error, "duplicate_name");
    eq("非法颜色被拒", (await anon.post("/api/admin/titles", { name: "彩色", color: "red" }, { admin: true })).body.error, "invalid_color");

    await anon.post("/api/admin/titles/" + manual.body.id + "/delete", {}, { admin: true });
    eq("删除后回落到自动头衔", (await alice.get("/api/auth/me")).body.user.title.name, "学长");

    await anon.post("/api/admin/users/1", { action: "set_exp", value: 49 }, { admin: true });
    eq("49 经验仍是 1 级", (await anon.get("/api/admin/users/1", { admin: true })).body.user.level, 1);
    await anon.post("/api/admin/users/1", { action: "set_exp", value: 50 }, { admin: true });
    eq("50 经验升到 2 级", (await anon.get("/api/admin/users/1", { admin: true })).body.user.level, 2);
    await anon.post("/api/admin/users/1", { action: "set_level", value: 5 }, { admin: true });
    eq("直接设等级会同步经验", (await anon.get("/api/admin/users/1", { admin: true })).body.user.exp, 500);
  }

  section("后台：用户信息完整可见");
  {
    const users = await anon.get("/api/admin/users", { admin: true });
    eq("用户列表返回 4 人", users.body.items.length, 4);
    const one = users.body.items[0];
    ok("含邮箱", typeof one.email === "string" && one.email.includes("@"));
    ok("含 uuid", typeof one.uuid === "string" && one.uuid.length === 36);
    ok("含学校", typeof one.school === "string" && one.school.length > 0);
    ok("含昵称预审标记字段", "nicknameFlagged" in one);
    ok("含注册/登录时间", one.createdAt > 0);
    ok("含 IP / UA 哈希（非明文）", typeof one.ipHash === "string");
    ok("含各项内容计数", Boolean(one.counts) && typeof one.counts.posts === "number" && typeof one.counts.friends === "number");

    const detail = await anon.get("/api/admin/users/" + one.id, { admin: true });
    ok("详情含最近帖子/评论/主题/私信",
      Boolean(detail.body.recent) && Array.isArray(detail.body.recent.posts)
      && Array.isArray(detail.body.recent.comments) && Array.isArray(detail.body.recent.messages));

    eq("按邮箱搜索命中 1 人", (await anon.get("/api/admin/users?q=alice", { admin: true })).body.items.length, 1);

    eq("改名成功", (await anon.post("/api/admin/users/1", { action: "rename", value: "满同学" }, { admin: true })).status, 200);
    eq("后台改名不受前端冷却限制", (await anon.get("/api/admin/users/1", { admin: true })).body.user.nickname, "满同学");
    eq("后台改名会清掉昵称预审标记", (await anon.get("/api/admin/users/1", { admin: true })).body.user.nicknameFlagged, "");
  }

  section("后台：公告 / 学校 / 统计 / 队列");
  {
    const ann = await anon.post("/api/admin/announcements", {
      body: "期末周互助帖已开放", link: "/forum", linkText: "去看看"
    }, { admin: true });
    eq("发布公告", ann.status, 201);
    const site = await anon.get("/api/site");
    eq("公告出现在站点信息里", site.body.announcements.length, 1);
    eq("公告链接正确", site.body.announcements[0].link, "/forum");

    await anon.post("/api/admin/announcements", { body: "危险链接", link: "javascript:alert(1)" }, { admin: true });
    const site2 = await anon.get("/api/site");
    ok("javascript: 链接被过滤", site2.body.announcements.every((a) => !String(a.link).startsWith("javascript:")));

    await anon.post("/api/admin/announcements/" + ann.body.id, { active: false }, { admin: true });
    ok("下线后不再下发", (await anon.get("/api/site")).body.announcements.every((a) => a.id !== ann.body.id));

    const schools = await anon.get("/api/admin/schools", { admin: true });
    ok("学校列表带使用人数", schools.body.items.some((s) => s.userCount >= 3), schools.body.items);

    await anon.post("/api/admin/schools/" + schools.body.items.find((s) => s.name === "第二大学").id, { active: false }, { admin: true });
    eq("停用后不再出现在注册列表", (await anon.get("/api/schools")).body.items.length, 1);

    const stats = await anon.get("/api/admin/stats", { admin: true });
    eq("统计里的用户数", stats.body.users, 4);
    eq("统计里的版本号", stats.body.version, "1.0.1");
    ok("统计含活跃/论坛/私信指标",
      typeof stats.body.activeToday === "number" && typeof stats.body.threads === "number" && typeof stats.body.dmsToday === "number");

    const q1 = await anon.get("/api/admin/queue?type=threads", { admin: true });
    eq("主题队列可读", q1.body.type, "threads");
    const q2 = await anon.get("/api/admin/queue?type=replies", { admin: true });
    eq("回复队列可读", q2.body.type, "replies");
  }

  section("审核：命中词库的内容仍然转人工");
  {
    const flaggedPost = await bob.post("/api/posts", { cat: "表白", body: "这条包含测试违禁词" });
    eq("命中词库的表白转人工", flaggedPost.body.status, "pending");
    eq("它不会出现在公开列表里", (await anon.get("/api/posts")).body.items.length, 1); // 只有上面那条干净的
    const pq = await anon.get("/api/admin/queue?type=posts", { admin: true });
    eq("同时进后台待审队列", pq.body.items.length, 1);
    eq("队列项带命中标记", Boolean(pq.body.items[0].flag), true);
    await anon.post("/api/admin/posts/" + pq.body.items[0].id + "/approve", {}, { admin: true });
    eq("人工放行后可见", (await anon.get("/api/posts")).body.items.length, 2);
  }

  section("审核：命中预筛的论坛内容进队列");
  {
    // 用测试词表里的词触发预筛 → 主题应为 pending
    const flagged = await bob.post("/api/forum/threads", {
      board: "general", title: "测试违禁词", body: "正文里也带上测试违禁词"
    });
    eq("命中预筛的主题转人工", flagged.body.status, "pending");
    const queue = await anon.get("/api/admin/queue?type=threads", { admin: true });
    eq("出现在主题队列里", queue.body.items.length, 1);
    eq("队列项带命中标记", Boolean(queue.body.items[0].flag), true);
    eq("队列项带作者信息（便于判断）", queue.body.items[0].author.nickname, "阿波");

    // 队列翻页：升序队列的游标必须是「大于」，写成「小于」会永远取不到第二页。
    // 用 dave 发帖：bob 在 10 分钟内已经用掉发帖配额（限流是刻意的，不去绕过它）。
    const extra = await dave.post("/api/forum/threads", { board: "general", title: "测试违禁词第二帖", body: "内容" });
    eq("第二条命中预筛的主题也进队列", extra.body.status, "pending");

    const page1 = await anon.get("/api/admin/queue?type=threads&limit=1", { admin: true });
    eq("队列每页按 limit 返回", page1.body.items.length, 1);
    ok("第一页带游标（说明还有下一页）", page1.body.nextCursor > 0, page1.body.nextCursor);
    const page2 = await anon.get("/api/admin/queue?type=threads&limit=1&cursor=" + page1.body.nextCursor, { admin: true });
    eq("第二页能取到剩下的待审主题", page2.body.items.length, 1);
    ok("两页返回的是不同条目", page2.body.items[0].id !== page1.body.items[0].id,
      { first: page1.body.items[0].id, second: page2.body.items[0].id });
    eq("翻到底后不再有游标", page2.body.nextCursor, null);
    await anon.post("/api/admin/threads/" + extra.body.id + "/remove", {}, { admin: true });

    await anon.post("/api/admin/threads/" + flagged.body.id + "/approve", {}, { admin: true });
    eq("审核通过后公开", (await anon.get("/api/forum/threads/" + flagged.body.id)).status, 200);

    const flaggedReply = await bob.post("/api/forum/threads/" + threadId + "/replies", { body: "测试违禁词回复" });
    eq("命中预筛的回复转人工", flaggedReply.body.status, "pending");
    await anon.post("/api/admin/replies/" + flaggedReply.body.id + "/remove", {}, { admin: true });
    eq("下架的回复不出现在详情里",
      (await anon.get("/api/forum/threads/" + threadId)).body.replies.every((r) => r.id !== flaggedReply.body.id),
      true);
  }

  section("首页 Markdown 与名单（v1.0.1）");
  {
    const home = await anon.get("/api/home");
    eq("首页可读（默认内容非空）", home.status, 200);
    ok("默认首页带欢迎语", String(home.body.markdown).includes("欢迎"), home.body.markdown.slice(0, 40));

    const saved = await anon.post("/api/admin/home", {
      markdown: "# 测试首页\n\n- 第一行\n- 第二行\n\n**加粗** 和 [链接](/forum)"
    }, { admin: true });
    eq("后台可保存首页", saved.status, 200);
    const after = await anon.get("/api/home");
    ok("保存后前台立刻可见", String(after.body.markdown).includes("测试首页"), after.body.markdown.slice(0, 30));

    const blocked = await anon.post("/api/admin/home", { markdown: "x" }, {});
    eq("未带令牌不能改首页", blocked.status, 401);

    const credits = await anon.get("/api/credits");
    eq("名单接口可读", credits.status, 200);
    ok("带开发者名单", Array.isArray(credits.body.developers) && credits.body.developers.length >= 1, credits.body.developers);
    ok("带感谢名单（赞助为空时是空数组）", Array.isArray(credits.body.thanks), credits.body.thanks);
  }

  section("后台：邮件通道自检");
  {
    eq("未带令牌被拒", (await anon.post("/api/admin/email/test", { to: "someone@example.com" })).status, 401);
    eq("非法收件地址被拒",
      (await anon.post("/api/admin/email/test", { to: "not-an-email" }, { admin: true })).body.error,
      "invalid_email");

    // 测试环境没配 Cloudflare 凭据：必须**如实**回报失败（降级到日志 + outbox），
    // 绝不能假装成功 —— 否则运维会以为通道通了，直到用户登录失败才发现。
    const result = await anon.post("/api/admin/email/test", { to: "someone@example.com" }, { admin: true });
    eq("未配置时返回 200（把原因说清楚，而不是 5xx）", result.status, 200);
    eq("如实标记未发送成功", result.body.ok, false);
    ok("标明走的是降级路径（日志 + outbox）", result.body.degraded === true, result.body);
    ok("带上失败原因", String(result.body.error).length > 0, result.body.error);
    eq("同时告知当前是否已配置", result.body.configured, false);

    const stats = await anon.get("/api/admin/stats", { admin: true });
    ok("统计接口暴露邮件配置状态（后台据此显示）",
      Boolean(stats.body.email) && stats.body.email.configured === false, stats.body.email);
  }

  section("退出登录与反馈");
  {
    eq("退出成功", (await alice.post("/api/auth/logout", {})).status, 200);
    eq("退出后会话失效", (await alice.get("/api/auth/me")).body.user, null);
    eq("未登录也能提交反馈", (await anon.post("/api/feedback", { cat: "idea", body: "希望支持深色模式" })).status, 201);
    eq("反馈进入后台队列", (await anon.get("/api/admin/feedback", { admin: true })).body.items.length, 1);
  }

  console.log("\n=== 通过 " + passed + " / 失败 " + failed + " ===");
  if (failed) {
    console.log("失败用例：" + failures.join("、"));
    console.log("\n服务端日志（尾部）：\n" + serverLog.split("\n").slice(-30).join("\n"));
  }
  cleanup();
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("测试崩溃：" + ((err && err.stack) || err));
  console.log("\n服务端日志（尾部）：\n" + serverLog.split("\n").slice(-40).join("\n"));
  cleanup();
  process.exit(1);
});
