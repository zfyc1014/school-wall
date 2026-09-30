"use strict";

/**
 * 后端接口测试：直接对真实 server/src/server.js 发请求（不是一个 mock）。
 *
 * 覆盖：
 *   - keyset 分页（sort=new / sort=hot / 分类过滤）游标推进正确、不重不漏
 *   - 内测门禁关闭时：配置报告未启用、写接口放行、响应不含任何第三方挑战密钥
 *   - 内测门禁开启后（邀请码 + 一次性本地挑战）：无凭据写请求 403 gate_required、
 *     邀请码错误 invalid_code、答对换取会话 cookie、挑战一次性（重放 409）、
 *     答错超限即作废、伪造 cookie 被拦、登出后重新被拦
 *   - 先审后发：新帖不进公开列表，审核通过后才出现
 *   - 内测反馈：需过门禁、正文长度校验、正常落库返回 id
 *   - ETag 条件请求返回 304、管理接口鉴权、CSP 收紧到 'self'
 *   - 生产环境未配置 GATE_INVITE_CODES 时拒绝启动（启动守卫）
 *
 * 用法：node scripts/api-test.js
 * 全部使用临时数据库与临时端口，不会碰 data/wall.db。
 */

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const PORT = 8099 + Math.floor(Math.random() * 300);
const HOST = "127.0.0.1";
const BASE = `http://${HOST}:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "od-api-test-"));
const ADMIN_TOKEN = crypto.randomBytes(24).toString("hex");

/** 门禁档使用的邀请码（gate.js 要求至少 8 位，过短的会被忽略） */
const INVITE_CODE = "API-TEST-INVITE-1";

const results = [];
const ok = (name, detail = "") => { results.push(true); console.log(`  \u2713 ${name}${detail ? `  — ${detail}` : ""}`); };
const bad = (name, detail = "") => { results.push(false); console.log(`  \u2717 ${name}${detail ? `  — ${detail}` : ""}`); };
const check = (name, cond, detail = "") => { if (cond) ok(name, detail); else bad(name, detail); return Boolean(cond); };

const env = {
  ...process.env,
  HOST,
  PORT: String(PORT),
  NODE_ENV: "development", // 允许未配置密钥启动，便于测「门禁关闭」这一档
  DB_PATH: path.join(TMP, "wall.db"),
  ADMIN_TOKEN,
  IP_HASH_SECRET: crypto.randomBytes(16).toString("hex"),
  WEB_ROOT: path.resolve(__dirname, "..", ".."), // 与 server.js 的默认一致（仓库根）
  INDEX_FILE: "index.html",
  LIKE_FLUSH_MS: "60",
  FEED_CACHE_MS: "0", // 测试里关掉短时缓存，避免掩盖数据变化
  ADMIN_RATE_LIMIT: "1000", // 测试会高频调管理接口，放宽鉴权限流
  DEBUG_EXIT: "1", // 打开退出追踪，便于定位异常退出
  DB_CHECKPOINT_MS: "600000",
  DB_CLEANUP_MS: "600000",
  GATE_ENFORCE: "0", // 基础档：内测门禁关闭
  GATE_INVITE_CODES: "",
  // 不读 server/.env：测试结果必须只由下面这些显式变量决定，
  // 否则开发机上那份 .env 会悄悄改变被测进程的行为（见 src/env.js）。
  OD_SKIP_ENV_FILE: "1"
};

let server = null;
/** 服务进程是否还活着 + 最近的输出，fetch 失败时用来定位原因 */
let serverLog = () => "";
let serverAlive = () => false;

function startServer(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "..", "src", "server.js")], {
      env: Object.assign({}, env, extraEnv),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let out = "";
    let alive = true;
    const onData = (chunk) => {
      out += String(chunk);
      if (/\[up\] 表白墙服务/.test(out)) {
        serverLog = () => out;
        serverAlive = () => alive;
        resolve({ child, log: () => out });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code, signal) => {
      alive = false;
      serverAlive = () => false;
      // 把退出码/信号一并报出来：原生断言失败会是 134 或 signal=SIGABRT，
      // 与「被测试脚本主动 kill」是完全不同的两件事，必须能区分。
      process.stderr.write(`\n[服务进程退出] pid=${child.pid} code=${code} signal=${signal}\n`);
      reject(new Error(`服务退出 code=${code} signal=${signal}\n${out}`));
    });
    setTimeout(() => reject(new Error(`启动超时\n${out}`)), 20000);
  });
}

/**
 * 启动一个**应当拒绝启动**的进程，等它自己退出并收集全部输出。
 * 与 startServer 的区别：这里期待的是启动失败，所以不等待就绪日志。
 */
function startExpectExit(extraEnv = {}, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, "..", "src", "server.js")], {
      env: Object.assign({}, env, extraEnv),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let out = "";
    let settled = false;
    const done = (result) => { if (!settled) { settled = true; resolve(result); } };
    const onData = (chunk) => { out += String(chunk); };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code, signal) => done({ code, signal, out }));
    setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      done({ code: null, signal: "timeout", out });
    }, timeoutMs);
  });
}

async function stopServer(child) {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  // 等进程真的退出：紧接着要在同一端口上起下一个进程，端口没释放会 EADDRINUSE
  const exited = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
  try { child.kill("SIGKILL"); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 150));
}

async function api(pathname, options = {}) {
  const init = Object.assign({ headers: {} }, options);
  let res = null;
  let lastErr = null;

  // 一次重试：本脚本会在中途重启被测服务，而 Node 的 fetch（undici）会保留
  // keep-alive 连接池，旧连接可能指向刚被替换掉的进程。这类失败是测试脚手架的
  // 问题，不是服务的问题，重试一次即可；同时把 socket 层错误码打出来便于判断。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      process.stderr.write(`      → ${init.method || "GET"} ${pathname}\n`);
      res = await fetch(BASE + pathname, init);
      process.stderr.write(`      ← ${res.status}\n`);
      break;
    } catch (err) {
      lastErr = err;
      const code = err?.cause?.code || err?.code || "";
      const alive = serverAlive();
      if (!alive) {
        throw new Error(
          `请求 ${pathname} 失败（${err.message}${code ? ` / ${code}` : ""}）；服务进程已退出`
          + `\n--- 服务输出 ---\n${serverLog()}`
        );
      }
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      throw new Error(
        `请求 ${pathname} 失败两次（${err.message}${code ? ` / ${code}` : ""}）；服务仍在运行`
      );
    }
  }

  let body = null;
  const text = await res.text();
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}

/** JSON POST 的简写：测试里绝大多数写请求都是这个形状 */
const jsonPost = (pathname, payload, extraHeaders = {}) => api(pathname, {
  method: "POST",
  headers: Object.assign({ "content-type": "application/json" }, extraHeaders),
  body: JSON.stringify(payload)
});

/**
 * 从题面算出答案。
 * 出题格式由 gate.js 的 makeItem 固定为「两位数 ± 一位数 = ?」，
 * 题面里只有题目、没有答案，所以测试必须自己解析（这也顺带证明题目确实可解）。
 */
function solve(q) {
  const m = /^\s*(\d+)\s*([+\-])\s*(\d+)\s*=\s*\?\s*$/.exec(String(q || ""));
  if (!m) throw new Error(`无法解析的挑战题面：${JSON.stringify(q)}`);
  const a = Number(m[1]);
  const b = Number(m[3]);
  return String(m[2] === "+" ? a + b : a - b);
}

const solveAll = (items) => (items || []).map((it) => solve(it.q));

/** 取一份挑战并解答（答案只存在服务端，客户端只能自己算） */
async function fetchChallenge() {
  const res = await api("/api/gate/challenge", { method: "POST" });
  const items = res.body.items || [];
  return { challengeRes: res, challengeId: res.body.id, items, answers: solveAll(items) };
}

/** 完整走一遍「取题 → 填邀请码与答案 → 换会话」，返回原始 Set-Cookie */
async function openGateSession(code) {
  const challenge = await fetchChallenge();
  const res = await jsonPost("/api/gate/verify", {
    code,
    challengeId: challenge.challengeId,
    answers: challenge.answers
  });
  const setCookie = res.headers.get("set-cookie") || "";
  return {
    res,
    setCookie,
    cookie: setCookie.split(";")[0],
    challengeId: challenge.challengeId,
    items: challenge.items,
    answers: challenge.answers
  };
}

/**
 * 灌入测试数据（独立进程写库，测试进程自己不持有 SQLite 连接）。
 *
 * 失败必须立刻抛错：灌数据进程崩掉时若被忽略，后面所有分页断言都会以
 * 「列表为空」这种极具误导性的形式一起失败，排错要多花十倍时间。
 */
function seed(count, extraEnv) {
  const script = `
    process.env.DB_PATH = ${JSON.stringify(env.DB_PATH)};
    const db = require(${JSON.stringify(path.join(__dirname, "..", "src", "db.js"))});
    const ins = db.prepare("INSERT INTO posts (cat,body,status,like_count,created_at) VALUES (?,?,?,?,?)");
    const tx = db.transaction(() => {
      const cats = ["表白","树洞","寻人","失物","致谢"];
      const base = Date.now();
      for (let i = 0; i < ${count}; i++) {
        ins.run(cats[i % 5], "接口测试内容 " + i, "approved", ${count} - i, base - i * 1000);
      }
    });
    tx();
    console.log("seeded " + db.prepare("SELECT COUNT(*) AS n FROM posts WHERE status='approved'").get().n);
    // 必须干净收尾：带活连接直接 process.exit 会触发 better-sqlite3 的原生断言，
    // 进程以 SIGABRT 结束（灌数据进程崩掉不会被注意，但会污染日志与退出码判断）。
    db.shutdown();
    db.close();
  `;

  const runOnce = () => new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", script], {
      env: Object.assign({}, env, extraEnv || {}),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let out = "";
    child.stdout.on("data", (c) => { out += String(c); });
    child.stderr.on("data", (c) => { out += String(c); });
    child.on("exit", (code) => resolve({ code, out }));
    setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, 15000);
  });

  return async () => {
    let last = { code: null, out: "" };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // 重试前先删掉可能写了一半的库文件（此时还没有服务在用它）
      for (const suffix of ["", "-wal", "-shm"]) {
        try { fs.rmSync(env.DB_PATH + suffix, { force: true }); } catch { /* ignore */ }
      }
      last = await runOnce();
      if (last.code === 0 && last.out.includes(`seeded ${count}`)) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`灌入测试数据失败（code=${last.code}）\n${last.out}`);
  };
}

(async () => {
  console.log(`\n后端接口测试：${BASE}（临时库 ${env.DB_PATH}）\n`);

  /* ── 准备：先建库灌数据，再启动服务 ── */
  await seed(45)();
  const started = await startServer();
  server = started.child;

  /* ── 1. keyset 分页 ─────────────────────────────────────────── */
  console.log("[1/7] keyset 分页（sort=new）");
  const p1 = await api("/api/posts?sort=new&limit=20");
  check("首屏返回 20 条且有游标", p1.status === 200 && p1.body.items.length === 20 && p1.body.nextCursor, `nextCursor=${p1.body.nextCursor}`);

  const p2 = await api(`/api/posts?sort=new&limit=20&cursor=${encodeURIComponent(p1.body.nextCursor)}`);
  const idsPage1 = new Set(p1.body.items.map((i) => i.id));
  const overlap = p2.body.items.filter((i) => idsPage1.has(i.id));
  check("第二页与第一页无重叠", overlap.length === 0, `重叠 ${overlap.length} 条`);
  check("游标格式为 created_at.id 且可推进", /^\d+\.\d+$/.test(p1.body.nextCursor), p1.body.nextCursor);

  const p3 = await api(`/api/posts?sort=new&limit=20&cursor=${encodeURIComponent(p2.body.nextCursor)}`);
  check("第三页取到剩余 5 条且到底", p3.body.items.length === 5 && p3.body.nextCursor === null, `${p3.body.items.length} 条 · cursor=${p3.body.nextCursor}`);

  const all = [...p1.body.items, ...p2.body.items, ...p3.body.items];
  const sortedDesc = all.every((it, i) => i === 0 || all[i - 1].createdAt >= it.createdAt);
  check("跨页结果严格按时间倒序（无重复/无遗漏）", all.length === 45 && sortedDesc && new Set(all.map((i) => i.id)).size === 45, `共 ${all.length} 条`);

  // 旧版纯 id 游标必须还能用（升级兼容）
  const legacy = await api(`/api/posts?sort=new&limit=20&cursor=${p1.body.items[9].id}`);
  check("兼容旧版纯 id 游标", legacy.status === 200 && legacy.body.items.length === 20, `返回 ${legacy.body.items.length} 条`);

  // 回归：不带 limit 时必须用默认页大小。
  // 这里踩过的坑：Number(null) === 0，如果 toInt 少了「null/空串走 fallback」这一步，
  // 缺省 limit 会被静默吞成 0 → clamp 到 1，首屏恒定只返回 1 条内容。
  const defaultPage = await api("/api/posts?sort=new");
  check("缺省 limit 时按默认页大小返回（不被 Number(null)=0 吞成 1 条）",
    defaultPage.status === 200 && defaultPage.body.items.length === 20 && Boolean(defaultPage.body.nextCursor),
    `${defaultPage.body.items.length} 条 · cursor=${defaultPage.body.nextCursor ? "有" : "无"}`);

  /* ── 2. 热榜与分类分页 ──────────────────────────────────────── */
  console.log("\n[2/7] 分页（sort=hot 与分类过滤）");
  const h1 = await api("/api/posts?sort=hot&limit=20");
  const h2 = await api(`/api/posts?sort=hot&limit=20&cursor=${encodeURIComponent(h1.body.nextCursor)}`);
  const likesDesc = [...h1.body.items, ...h2.body.items].every((it, i, arr) => i === 0 || arr[i - 1].likes >= it.likes);
  check("热榜按点赞降序且分页无重叠", likesDesc && /^\d+\.\d+$/.test(h1.body.nextCursor), `cursor=${h1.body.nextCursor}`);

  const c1 = await api("/api/posts?sort=new&limit=10&cat=" + encodeURIComponent("树洞"));
  check("分类过滤只返回该分类", c1.body.items.length > 0 && c1.body.items.every((i) => i.cat === "树洞"), `${c1.body.items.length} 条`);
  if (c1.body.nextCursor) {
    const c2 = await api("/api/posts?sort=new&limit=10&cat=" + encodeURIComponent("树洞") + "&cursor=" + encodeURIComponent(c1.body.nextCursor));
    const cIds = new Set(c1.body.items.map((i) => i.id));
    check("分类分页无重叠", c2.body.items.every((i) => !cIds.has(i.id)), `第二页 ${c2.body.items.length} 条`);
  } else {
    ok("分类分页无重叠", "该分类不足一页，跳过");
  }

  const q = await api("/api/posts?q=" + encodeURIComponent("接口测试内容 1"));
  check("关键词搜索可用", q.status === 200 && Array.isArray(q.body.items), `${q.body.items.length} 条`);

  /* ── 3. ETag ────────────────────────────────────────────────── */
  console.log("\n[3/7] ETag 条件请求");
  const e1 = await api("/api/posts?sort=new&limit=20");
  const etag = e1.headers.get("etag");
  check("列表响应带 ETag", Boolean(etag), etag || "(无)");
  const e2 = await api("/api/posts?sort=new&limit=20", { headers: { "if-none-match": etag } });
  check("带 If-None-Match 返回 304", e2.status === 304, `status=${e2.status}`);

  /* ── 4. 门禁关闭时的行为（自托管门禁，不下发任何第三方密钥）─── */
  console.log("\n[4/7] 写接口与内测门禁配置（当前门禁关闭）");
  const cfg = await api("/api/gate/config");
  check("配置接口可用且标记门禁未启用",
    cfg.status === 200 && cfg.body.enabled === false && cfg.body.required === false,
    JSON.stringify(cfg.body));

  // 反向断言：自托管门禁不下发 siteKey 之类的第三方挑战密钥。
  // 一旦有人把 Turnstile/reCAPTCHA 的密钥字段加回来，这条会立刻失败。
  const cfgText = JSON.stringify(cfg.body);
  check("配置响应不含任何第三方挑战密钥字段",
    !/siteKey|site_key|turnstile|recaptcha|hcaptcha/i.test(cfgText),
    cfgText.slice(0, 140) + "…");

  const wrote = await jsonPost("/api/posts", { cat: "表白", body: "接口测试：这条应该进入审核队列。" });
  check("未启用门禁时写接口放行（返回 pending）", wrote.status === 201 && wrote.body.status === "pending", JSON.stringify(wrote.body));

  const fbOpen = await jsonPost("/api/feedback", { body: "门禁关闭时反馈入口应当可用。", cat: "other" });
  check("门禁关闭时反馈可直接提交并返回 id",
    fbOpen.status === 201 && fbOpen.body.ok === true && Number(fbOpen.body.id) > 0, JSON.stringify(fbOpen.body));

  /* ── 5. 先审后发 ────────────────────────────────────────────── */
  console.log("\n[5/7] 先审后发与审核流转");
  const feedAfterPost = await api("/api/posts?sort=new&limit=50");
  const leaked = feedAfterPost.body.items.some((i) => String(i.id) === String(wrote.body.id));
  check("未审核的新帖不出现在公开列表", !leaked);

  const stats = await api("/api/admin/stats", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
  check("管理统计可读且包含数据库体积", stats.status === 200 && stats.body.pendingPosts >= 1 && stats.body.db && stats.body.db.fileBytes > 0,
    `pending=${stats.body.pendingPosts} · db=${Math.round((stats.body.db?.fileBytes || 0) / 1024)}KB`);

  const unauth = await api("/api/admin/stats");
  check("管理接口未鉴权被拒", unauth.status === 401, `status=${unauth.status}`);

  const approve = await api(`/api/admin/posts/${wrote.body.id}/approve`, { method: "POST", headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
  check("审核通过成功", approve.status === 200 && approve.body.status === "approved", JSON.stringify(approve.body));

  const feedAfterApprove = await api("/api/posts?sort=new&limit=50");
  check("审核通过后出现在公开列表", feedAfterApprove.body.items.some((i) => String(i.id) === String(wrote.body.id)));

  /* ── 6. 开启内测门禁后的服务端闸门 ─────────────────────────── */
  console.log("\n[6/7] 开启内测门禁后的服务端闸门（邀请码 + 一次性挑战）");
  await stopServer(server);
  server = null;
  const started2 = await startServer({
    GATE_ENFORCE: "1",
    GATE_INVITE_CODES: INVITE_CODE,
    GATE_COOKIE_SECURE: "0", // 本地是明文 HTTP；这里只验证服务端签发的 cookie 属性
    GATE_MAX_ATTEMPTS: "2"   // 压到 2 次，几条请求就能验证「答错超限即作废」
  });
  server = started2.child;

  const cfg2 = await api("/api/gate/config");
  check("配置接口报告门禁必需",
    cfg2.status === 200 && cfg2.body.enabled === true && cfg2.body.required === true && cfg2.body.inviteRequired === true,
    JSON.stringify(cfg2.body));

  const blocked = await jsonPost("/api/posts", { cat: "表白", body: "没有门禁凭据的请求，必须被拦下。" });
  check("没有凭据的写请求被 403 拦下", blocked.status === 403 && blocked.body.error === "gate_required", JSON.stringify(blocked.body));

  const wrongInvite = await jsonPost("/api/gate/verify", { code: "NOT-A-VALID-CODE", challengeId: "x", answers: [] });
  check("邀请码错误返回 403 invalid_code",
    wrongInvite.status === 403 && wrongInvite.body.error === "invalid_code", JSON.stringify(wrongInvite.body));

  const session = await openGateSession(INVITE_CODE);
  check("正确邀请码 + 正确挑战答案换取会话",
    session.res.status === 200 && session.res.body.verified === true && /od_gate=/.test(session.setCookie),
    `status=${session.res.status} · ${JSON.stringify(session.res.body)}`);
  check("会话 cookie 为 HttpOnly + SameSite=Lax + Path=/",
    /HttpOnly/i.test(session.setCookie) && /SameSite=Lax/i.test(session.setCookie) && /Path=\//.test(session.setCookie),
    session.setCookie);
  const cookie = session.cookie;

  const withSession = await jsonPost("/api/posts", { cat: "树洞", body: "带门禁会话的请求应该被放行。" }, { cookie });
  check("带会话 cookie 的写请求放行（进入待审）",
    withSession.status === 201 && withSession.body.status === "pending", JSON.stringify(withSession.body));

  const cfgWithCookie = await api("/api/gate/config", { headers: { cookie } });
  check("配置接口反映当前会话已验证", cfgWithCookie.body.verified === true, `verified=${cfgWithCookie.body.verified}`);

  // 一次性：答对后服务端立刻作废该挑战，不给重放留窗口
  const replay = await jsonPost("/api/gate/verify", {
    code: INVITE_CODE, challengeId: session.challengeId, answers: session.answers
  });
  check("挑战一次性：同 id + 同答案重放返回 409 challenge_expired",
    replay.status === 409 && replay.body.error === "challenge_expired", JSON.stringify(replay.body));

  // 答错上限：本档 GATE_MAX_ATTEMPTS=2
  const ch2 = await fetchChallenge();
  const wrong1 = await jsonPost("/api/gate/verify", { code: INVITE_CODE, challengeId: ch2.challengeId, answers: ["-1"] });
  check("答错一次返回剩余可试次数",
    wrong1.status === 403 && wrong1.body.error === "challenge_failed" && wrong1.body.remaining === 1,
    JSON.stringify(wrong1.body));
  await jsonPost("/api/gate/verify", { code: INVITE_CODE, challengeId: ch2.challengeId, answers: ["-1"] });
  const overLimit = await jsonPost("/api/gate/verify", { code: INVITE_CODE, challengeId: ch2.challengeId, answers: ch2.answers });
  check("答错超过 GATE_MAX_ATTEMPTS 后挑战作废（答案正确也不放行）",
    overLimit.status === 403 && overLimit.body.error === "challenge_failed" && /错误次数过多/.test(overLimit.body.message || ""),
    JSON.stringify(overLimit.body));
  const afterVoid = await jsonPost("/api/gate/verify", { code: INVITE_CODE, challengeId: ch2.challengeId, answers: ch2.answers });
  check("作废后的挑战彻底失效（再提交返回 409）",
    afterVoid.status === 409 && afterVoid.body.error === "challenge_expired", JSON.stringify(afterVoid.body));

  // 伪造 cookie：签名尾部改一位，长度不变但校验必然不等
  const eq = cookie.indexOf("=");
  const rawValue = cookie.slice(eq + 1);
  const dot = rawValue.indexOf(".");
  const tampered = cookie.slice(0, eq + 1)
    + rawValue.slice(0, dot + 1)
    + rawValue.slice(dot + 1, -1)
    + (rawValue.endsWith("A") ? "B" : "A");
  const forged = await jsonPost("/api/posts", { cat: "表白", body: "篡改过的会话 cookie 不应该被放行。" }, { cookie: tampered });
  check("伪造/篡改的 od_gate cookie 仍被 403 拦下",
    forged.status === 403 && forged.body.error === "gate_required", JSON.stringify(forged.body));

  const reportBlocked = await jsonPost("/api/reports", { postId: 1, reason: "没有门禁凭据的举报" });
  check("不带会话 cookie 的举报被 403 拦下",
    reportBlocked.status === 403 && reportBlocked.body.error === "gate_required", JSON.stringify(reportBlocked.body));
  const reportOk = await jsonPost("/api/reports", { postId: 1, reason: "带门禁会话的举报" }, { cookie });
  check("带会话 cookie 的举报放行（落一条新工单）", reportOk.status === 201, `status=${reportOk.status} · ${JSON.stringify(reportOk.body)}`);

  // 反馈同样受门禁约束（先过门禁，再看限流与长度）
  const fbBlocked = await jsonPost("/api/feedback", { body: "没有门禁凭据的反馈不应该入库。" });
  check("门禁开启时反馈也需要先过门禁",
    fbBlocked.status === 403 && fbBlocked.body.error === "gate_required", JSON.stringify(fbBlocked.body));
  const fbShort = await jsonPost("/api/feedback", { body: "短" }, { cookie });
  check("反馈正文过短返回 400", fbShort.status === 400, `status=${fbShort.status}`);
  const fbLong = await jsonPost("/api/feedback", { body: "长".repeat(900) }, { cookie });
  check("反馈正文超过 FEEDBACK_MAX 返回 400", fbLong.status === 400, `status=${fbLong.status}`);
  const fbOk = await jsonPost("/api/feedback", { body: "内测反馈：门禁题目建议多出一点。", contact: "tester@example.com", cat: "idea" }, { cookie });
  check("反馈正常落库并返回 id",
    fbOk.status === 201 && fbOk.body.ok === true && Number(fbOk.body.id) > 0, JSON.stringify(fbOk.body));

  const logout = await api("/api/gate/logout", { method: "POST" });
  const cleared = logout.headers.get("set-cookie") || "";
  check("登出接口返回未验证并清除 cookie",
    logout.status === 200 && logout.body.verified === false && /Max-Age=0/i.test(cleared),
    `${JSON.stringify(logout.body)} · ${cleared}`);
  const afterLogout = await jsonPost("/api/posts", { cat: "失物", body: "登出后不应该还能写入内容。" });
  check("登出后写请求重新被 403 拦下",
    afterLogout.status === 403 && afterLogout.body.error === "gate_required", JSON.stringify(afterLogout.body));

  // CSP 反向断言：内测版没有任何第三方脚本，安全头必须收紧
  const csp = (await api("/api/health")).headers.get("content-security-policy") || "";
  check("CSP 不再放行第三方脚本（script-src 'self' 且不含 challenges.cloudflare.com）",
    /script-src[^;]*'self'/.test(csp) && !/challenges\.cloudflare\.com/.test(csp), csp.slice(0, 120) + "…");
  check("CSP 禁止外部框架嵌入（frame-src 'none'）", /frame-src[^;]*'none'/.test(csp), csp.slice(0, 120) + "…");

  /* ── 7. 生产环境启动守卫 ───────────────────────────────────── */
  console.log("\n[7/7] 生产环境启动守卫（未配置邀请码时拒绝启动）");
  await stopServer(server);
  server = null;

  const guard = await startExpectExit({
    NODE_ENV: "production",
    PORT: String(PORT + 2),
    GATE_ENFORCE: "",        // 等价于未配置：生产 + 无邀请码 + 无逃生开关
    GATE_INVITE_CODES: ""
  });
  check("生产环境未配置邀请码时拒绝启动", guard.code === 1, `code=${guard.code} signal=${guard.signal}`);
  const fatalLine = (guard.out.match(/\[fatal\][^\n]*/) || [""])[0];
  check("拒绝启动时点明原因并给出可执行的修复说明",
    /GATE_INVITE_CODES/.test(guard.out)
      && /修复：设置 GATE_INVITE_CODES=/.test(guard.out)
      && /GATE_ALLOW_DISABLED/.test(guard.out),
    fatalLine);
})()
  .catch((err) => bad("接口测试异常中断", err?.message || String(err)))
  .finally(async () => {
    await stopServer(server);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
    const failed = results.filter((r) => !r).length;
    console.log(`\n${"─".repeat(64)}`);
    console.log(`后端接口测试：${results.length - failed}/${results.length} 通过`);
    if (failed) {
      console.log("失败项需要在合并前修掉。");
    }
    console.log(`${"─".repeat(64)}\n`);
    process.exit(failed ? 1 : 0);
  });
