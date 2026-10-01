#!/usr/bin/env node
/**
 * 路由巡检：把 `server.js` 里注册过的每个路由都真打一遍，只关心一件事 —— **有没有 5xx**。
 *
 * 为什么要单独写一个：
 *   本项目的测试是按「功能链路」组织的（门禁、先审后发、评论、举报、反馈、后台…），
 *   于是**不属于任何链路的处理器就成了盲区**。点赞接口的 SQL 把保留字 `ON` 当成列别名
 *   （`SELECT 1 AS on FROM likes`），真实后端上一点赞就 500，而 smoke（本地模式）、
 *   api-smoke（自带 mock 后端）、prod-e2e（没点过赞）、db-check（直接写表）全绿 ——
 *   四个套件没一个碰到它。这个脚本用「枚举注册表」的方式兜底：
 *   新增路由即使没人写针对性断言，也不会悄无声息地 500。
 *
 * 判定标准：
 *   - 4xx 一律不算失败 —— 鉴权失败、限流、参数不合法、内容不存在都是业务上的正常拒绝；
 *   - 5xx（以及请求本身抛错）才算，并打印响应体前 160 字便于定位；
 *   - `/api/admin/shutdown` 显式跳过：打它会把被测服务关掉。
 *
 * 用法：node server/scripts/route-sweep.js（`server/package.json` 的 test 链里已包含）
 */

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SERVER = path.join(__dirname, "..", "src", "server.js");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "wall-sweep-"));
const PORT = 8300 + Math.floor(Math.random() * 400);
const ADMIN_TOKEN = "sweep-admin-token-" + crypto.randomBytes(8).toString("hex");
const INVITE_CODE = "sweep-invite-" + crypto.randomBytes(4).toString("hex");
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
const ok = (name, detail = "") => { results.push(true); console.log(`  \u2713 ${name}${detail ? `  — ${detail}` : ""}`); };
const bad = (name, detail = "") => { results.push(false); console.log(`  \u2717 ${name}${detail ? `  — ${detail}` : ""}`); };
const check = (name, cond, detail = "") => { if (cond) ok(name, detail); else bad(name, detail); return Boolean(cond); };

const env = {
  ...process.env,
  HOST: "127.0.0.1",
  PORT: String(PORT),
  NODE_ENV: "production",
  DB_PATH: path.join(TMP, "wall.db"),
  WEB_ROOT: path.resolve(__dirname, "..", "..", "web", "dist"),
  INDEX_FILE: "index.html",
  ADMIN_TOKEN,
  IP_HASH_SECRET: crypto.randomBytes(16).toString("hex"),
  ADMIN_RATE_LIMIT: "1000",
  ADMIN_API_RATE_LIMIT: "5000",
  GATE_ENFORCE: "1",
  GATE_INVITE_CODES: INVITE_CODE,
  GATE_COOKIE_SECURE: "0", // 本地是明文 HTTP
  // 不读 server/.env：巡检结果只能由上面这些显式变量决定
  OD_SKIP_ENV_FILE: "1"
};

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let settled = false;
    const onData = (chunk) => {
      out += String(chunk);
      if (!settled && /\[up\] 表白墙服务/.test(out)) { settled = true; resolve(child); }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code, signal) => {
      if (!settled) { settled = true; reject(new Error(`服务退出 code=${code} signal=${signal}\n${out}`)); }
    });
    setTimeout(() => { if (!settled) { settled = true; reject(new Error(`启动超时\n${out}`)); } }, 20000);
  });
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  child.kill("SIGKILL");
  await exited;
}

/** 把注册表里的路由抓出来：普通字符串形式与模板字符串形式（后台那批是循环注册的） */
function collectRoutes() {
  const src = fs.readFileSync(SERVER, "utf8");
  const routes = [];
  for (const m of src.matchAll(/route\(\s*"([A-Z]+)"\s*,\s*"([^"]+)"/g)) {
    routes.push({ method: m[1], path: m[2] });
  }
  for (const m of src.matchAll(/route\(\s*"([A-Z]+)"\s*,\s*`([^`]+)`/g)) {
    // 循环注册的模板串：${act} / ${verb} 之类统一展开成 approve（最常用且幂等的动作）
    routes.push({ method: m[1], path: m[2].replace(/\$\{[^}]*\}/g, "approve") });
  }
  return routes;
}

async function request(pathname, { method = "GET", body, cookie, token } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(BASE + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed, raw: text, setCookie: res.headers.get("set-cookie") || "" };
}

const solve = (q) => {
  const m = String(q).match(/(\d+)\s*([+\-])\s*(\d+)/);
  if (!m) return "0";
  return m[2] === "+" ? String(Number(m[1]) + Number(m[3])) : String(Number(m[1]) - Number(m[3]));
};

(async () => {
  let child = null;
  try {
    console.log("\n[1/3] 启动真实服务（生产模式 + 门禁开启）并造数据");
    child = await startServer();
    ok("服务已就绪", `${BASE}`);

    // 过门禁，拿到会话 cookie
    const challenge = await request("/api/gate/challenge", { method: "POST", body: {} });
    const verified = await request("/api/gate/verify", {
      method: "POST",
      body: {
        code: INVITE_CODE,
        challengeId: challenge.body && challenge.body.id,
        answers: (challenge.body && challenge.body.items || []).map((i) => solve(i.q))
      }
    });
    const cookie = (verified.setCookie || "").split(";")[0];
    check("门禁会话已建立（巡检的写请求需要它）",
      verified.status === 200 && /od_gate=/.test(cookie), `status=${verified.status}`);

    // 造一条「已通过」的帖子和评论：让 /:id 类路由有真实数据可打
    const post = await request("/api/posts", {
      method: "POST", cookie, body: { cat: "树洞", body: "路由巡检用的内容，稍后会被审核通过。" }
    });
    const postId = post.body && post.body.id;
    await request(`/api/admin/posts/${postId}/approve`, { method: "POST", body: {}, token: ADMIN_TOKEN });
    const comment = await request(`/api/posts/${postId}/comments`, {
      method: "POST", cookie, body: { body: "路由巡检用的评论内容。" }
    });
    const commentId = comment.body && comment.body.id;
    await request(`/api/admin/comments/${commentId}/approve`, { method: "POST", body: {}, token: ADMIN_TOKEN });
    const report = await request("/api/reports", { method: "POST", cookie, body: { postId, reason: "路由巡检工单" } });
    // POST /api/reports 只回 { ok: true }（不暴露工单 id），id 从后台队列里取
    const reportQueue = await request("/api/admin/reports?status=open&limit=5", { token: ADMIN_TOKEN });
    const reportId = report.status === 201 && reportQueue.body && reportQueue.body.items && reportQueue.body.items[0]
      ? reportQueue.body.items[0].id
      : undefined;
    const feedback = await request("/api/feedback", { method: "POST", cookie, body: { body: "路由巡检用的反馈内容。" } });
    const feedbackId = feedback.body && feedback.body.id;
    check("巡检数据已就绪（帖子 / 评论 / 工单 / 反馈）",
      Boolean(postId && commentId && reportId && feedbackId),
      `post=${postId} comment=${commentId} report=${reportId} feedback=${feedbackId}`);

    console.log("\n[2/3] 逐条打注册表里的路由（4xx 算正常拒绝，5xx 才算失败）");
    // 同一个 :id 占位符在不同前缀下指向不同资源，按前缀给对应的 id 才有意义
    const idFor = (p) => {
      if (p.includes("/comments/")) return commentId;
      if (p.includes("/reports/")) return reportId;
      if (p.includes("/feedback/")) return feedbackId;
      return postId;
    };
    const routes = collectRoutes().filter((r) => !r.path.includes("shutdown"));
    const broken = [];
    let called = 0;
    for (const r of routes) {
      const pathname = r.path.replace(/:id/g, String(idFor(r.path)));
      const isAdmin = pathname.startsWith("/api/admin/");
      const isGate = pathname.startsWith("/api/gate/");
      const opts = { method: r.method, token: isAdmin ? ADMIN_TOKEN : undefined };
      if (r.method !== "GET") {
        opts.body = {};
        // 门禁自身的接口不需要会话（校验接口还要故意带错码，见下）
        if (!isGate && !isAdmin) opts.cookie = cookie;
      }
      let res;
      try {
        res = await request(pathname, opts);
      } catch (err) {
        broken.push(`${r.method} ${pathname} → 请求异常：${err.message}`);
        continue;
      }
      called += 1;
      if (res.status >= 500) broken.push(`${r.method} ${pathname} → ${res.status} ${res.raw.slice(0, 160)}`);
    }
    check(`注册表里的路由全部不返回 5xx（共 ${called} 条）`, broken.length === 0,
      broken.length ? broken.join(" | ") : "全部 4xx/2xx");

    // 门禁两个接口单独走一遍完整流程（上面按注册表打时用的是空 body，只会 4xx）
    const c2 = await request("/api/gate/challenge", { method: "POST", body: {} });
    check("出题接口返回一次性挑战", c2.status === 200 && Boolean(c2.body && c2.body.id), `status=${c2.status}`);
    const wrong = await request("/api/gate/verify", {
      method: "POST", body: { code: "definitely-wrong-code", challengeId: c2.body && c2.body.id, answers: ["0"] }
    });
    check("校验接口拒绝错误邀请码（403 invalid_code）",
      wrong.status === 403 && wrong.body && wrong.body.error === "invalid_code", `status=${wrong.status}`);

    console.log("\n[3/3] 结果");
  } finally {
    await stopServer(child);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  const failed = results.filter((r) => !r).length;
  console.log(`\n${"─".repeat(64)}`);
  console.log(`路由巡检：${results.length - failed}/${results.length} 通过`);
  if (failed) {
    console.log("巡检发现处理器级错误（5xx），修完再发版。");
    process.exit(1);
  }
  console.log("注册表里的每个路由都至少在真实服务上跑通过一次。");
})().catch((err) => {
  bad("路由巡检异常中断", err && err.message ? err.message : String(err));
  console.log(`\n路由巡检：${results.filter((r) => r).length}/${results.length + 1} 通过`);
  process.exit(1);
});
