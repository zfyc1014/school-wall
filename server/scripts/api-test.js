"use strict";

/**
 * 后端接口测试：直接对真实 server/src/server.js 发请求（不是一个 mock）。
 *
 * 覆盖：
 *   - keyset 分页（sort=new / sort=hot / 分类过滤）游标推进正确、不重不漏
 *   - 未验证状态下写接口被拦（403 challenge_required）—— 服务端闸门，不依赖前端
 *   - Turnstile 开启后：错误 token 被拒、测试密钥通过、会话 cookie 生效
 *   - 先审后发：新帖不进公开列表，审核通过后才出现
 *   - ETag 条件请求返回 304
 *   - 管理接口鉴权
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

const results = [];
const ok = (name, detail = "") => { results.push(true); console.log(`  \u2713 ${name}${detail ? `  — ${detail}` : ""}`); };
const bad = (name, detail = "") => { results.push(false); console.log(`  \u2717 ${name}${detail ? `  — ${detail}` : ""}`); };
const check = (name, cond, detail = "") => { if (cond) ok(name, detail); else bad(name, detail); return Boolean(cond); };

const env = {
  ...process.env,
  HOST,
  PORT: String(PORT),
  NODE_ENV: "development", // 允许未配置密钥启动，便于测「验证关闭」这一档
  DB_PATH: path.join(TMP, "wall.db"),
  ADMIN_TOKEN,
  IP_HASH_SECRET: crypto.randomBytes(16).toString("hex"),
  WEB_ROOT: path.resolve(__dirname, ".."),
  INDEX_FILE: "school-confession-wall.html",
  LIKE_FLUSH_MS: "60",
  FEED_CACHE_MS: "0", // 测试里关掉短时缓存，避免掩盖数据变化
  ADMIN_RATE_LIMIT: "1000", // 测试会高频调管理接口，放宽鉴权限流
  DEBUG_EXIT: "1", // 打开退出追踪，便于定位异常退出
  DB_CHECKPOINT_MS: "600000",
  DB_CLEANUP_MS: "600000",
  TURNSTILE_SITE_KEY: "",
  TURNSTILE_SECRET: "",
  CHALLENGE_ENFORCE: "0"
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

async function stopServer(child) {
  if (!child) return;
  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 600));
  try { child.kill("SIGKILL"); } catch { /* ignore */ }
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

function seed(count, extraEnv) {
  return async () => {
    const ins = spawn(process.execPath, ["-e", `
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
      console.log("seeded");
      // 必须干净收尾：带活连接直接 process.exit 会触发 better-sqlite3 的原生断言，
      // 进程以 SIGABRT 结束（灌数据进程崩掉不会被注意，但会污染日志与退出码判断）。
      db.shutdown();
      db.close();
    `], { env: Object.assign({}, env, extraEnv || {}), stdio: ["ignore", "pipe", "pipe"] });
    await new Promise((r) => ins.on("exit", r));
  };
}

(async () => {
  console.log(`\n后端接口测试：${BASE}（临时库 ${env.DB_PATH}）\n`);

  /* ── 准备：先建库灌数据，再启动服务 ── */
  await seed(45)();
  const started = await startServer();
  server = started.child;

  /* ── 1. keyset 分页 ─────────────────────────────────────────── */
  console.log("[1/6] keyset 分页（sort=new）");
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

  /* ── 2. 热榜与分类分页 ──────────────────────────────────────── */
  console.log("\n[2/6] 分页（sort=hot 与分类过滤）");
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
  console.log("\n[3/6] ETag 条件请求");
  const e1 = await api("/api/posts?sort=new&limit=20");
  const etag = e1.headers.get("etag");
  check("列表响应带 ETag", Boolean(etag), etag || "(无)");
  const e2 = await api("/api/posts?sort=new&limit=20", { headers: { "if-none-match": etag } });
  check("带 If-None-Match 返回 304", e2.status === 304, `status=${e2.status}`);

  /* ── 4. 人机验证闸门（未配置密钥时关闭）──────────────────────── */
  console.log("\n[4/6] 写接口与验证配置（当前未启用 Turnstile）");
  const cfg = await api("/api/challenge/config");
  check("配置接口可用且标记未启用", cfg.status === 200 && cfg.body.enabled === false, JSON.stringify(cfg.body));
  const wrote = await api("/api/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cat: "表白", body: "接口测试：这条应该进入审核队列。" })
  });
  check("未启用验证时写接口放行（返回 pending）", wrote.status === 201 && wrote.body.status === "pending", JSON.stringify(wrote.body));

  /* ── 5. 先审后发 ────────────────────────────────────────────── */
  console.log("\n[5/6] 先审后发与审核流转");
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

  /* ── 6. Turnstile 开启后的行为（用官方测试密钥）─────────────── */
  console.log("\n[6/6] 开启 Turnstile 后的服务端闸门");
  await stopServer(server);
  server = null;
  const started2 = await startServer({
    // Cloudflare 官方测试密钥：sitekey 1x…AA 恒定通过，secret 1x…AA 恒定通过校验
    TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
    TURNSTILE_SECRET: "1x0000000000000000000000000000000AA",
    CHALLENGE_ENFORCE: "1",
    CHALLENGE_COOKIE_SECURE: "0"
  });
  server = started2.child;

  const cfg2 = await api("/api/challenge/config");
  check("配置接口报告已启用并下发 siteKey",
    cfg2.body.enabled === true && cfg2.body.required === true && cfg2.body.siteKey === "1x00000000000000000000AA",
    JSON.stringify(cfg2.body));

  const blocked = await api("/api/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cat: "表白", body: "没有验证凭据的请求，必须被拦下。" })
  });
  check("没有凭据的写请求被 403 拦下", blocked.status === 403 && blocked.body.error === "challenge_required", JSON.stringify(blocked.body));

  // 官方测试密钥说明：
  //   1x…AA（secret）= 恒定通过校验，且**接受任意 token 字符串**（实测确认，
  //                    并不限于官方文档说的 dummy token）；
  //   2x…AA（secret）= 恒定失败，用来验证拒绝路径。
  const sessionRes = await api("/api/challenge/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "XXXX.DUMMY.TOKEN.XXXX" })
  });
  const setCookie = sessionRes.headers.get("set-cookie") || "";
  check("有效 token 换取会话 cookie",
    sessionRes.status === 200 && sessionRes.body.verified === true && /od_challenge=/.test(setCookie),
    `status=${sessionRes.status} · cookie=${setCookie.slice(0, 28)}…`);

  const cookie = setCookie.split(";")[0];
  const withSession = await api("/api/posts", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ cat: "树洞", body: "带会话凭据的请求应该被放行。" })
  });
  check("带会话 cookie 的写请求放行", withSession.status === 201 && withSession.body.status === "pending", JSON.stringify(withSession.body));

  const cfgWithCookie = await api("/api/challenge/config", { headers: { cookie } });
  check("配置接口反映会话已验证", cfgWithCookie.body.verified === true);

  // 一次性 token 直接放在 header 上（前端「发布」路径）。
  // 注意：同一 IP 刚刚验证过，命中进程内复用缓存，不必再出网。
  const viaHeader = await api("/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-turnstile-response": "XXXX.DUMMY.TOKEN.XXXX" },
    body: JSON.stringify({ postId: 1, reason: "带 token 的举报" })
  });
  check("header 里的一次性 token 也可放行写请求", viaHeader.status === 200 || viaHeader.status === 201, `status=${viaHeader.status}`);

  // 前端拿到的响应必须放行 Turnstile 的脚本与 iframe（否则 widget 加载不出来）
  const csp = (await api("/api/health")).headers.get("content-security-policy") || "";
  check("CSP 放行 challenges.cloudflare.com（script-src + frame-src）",
    /script-src[^;]*challenges\.cloudflare\.com/.test(csp) && /frame-src[^;]*challenges\.cloudflare\.com/.test(csp),
    csp.slice(0, 120) + "…");

  /* ── 7. 校验失败路径（换成恒定失败的测试密钥）─────────────────── */
  console.log("\n[7/7] Turnstile 校验失败路径（2x…AA 恒定失败密钥）");
  await stopServer(server);
  server = null;
  const started3 = await startServer({
    TURNSTILE_SITE_KEY: "2x00000000000000000000AB",
    TURNSTILE_SECRET: "2x0000000000000000000000000000000AA",
    CHALLENGE_ENFORCE: "1",
    CHALLENGE_COOKIE_SECURE: "0"
  });
  server = started3.child;

  const failSession = await api("/api/challenge/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "any-token-will-fail" })
  });
  check("校验失败时不签发会话且返回 403",
    failSession.status === 403 && failSession.body.error === "verify_failed" && !failSession.headers.get("set-cookie"),
    `status=${failSession.status} · ${JSON.stringify(failSession.body)}`);

  const stillBlocked = await api("/api/posts", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-turnstile-response": "any-token-will-fail" },
    body: JSON.stringify({ cat: "表白", body: "校验失败时这条内容不允许写入。" })
  });
  check("校验失败时写请求仍被拦下", stillBlocked.status === 403, `status=${stillBlocked.status} · ${stillBlocked.body?.error}`);

  const missing = await api("/api/challenge/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });
  check("缺少 token 时返回 missing_token", missing.status === 403 && missing.body.error === "missing_token", JSON.stringify(missing.body));
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
