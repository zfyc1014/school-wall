"use strict";

/**
 * 路由巡检（v1.0.0）。
 *
 * 起因是一个真实事故：点赞接口的 SQL 把保留字 ON 当别名（SELECT 1 AS on），
 * 真实后端上一点赞就 500 —— 而当时按链路组织的测试全都碰不到这条路径。
 * **按功能链路组织测试，必然留下不属于任何链路的盲区。**
 *
 * 所以这里换个思路：直接从 server.js 里把**注册过的每一条路由**抠出来，
 * 真起一个服务、真发一遍请求，断言「没有任何 5xx」。
 * 4xx 是正常的业务拒绝（未登录、参数不对、内容不存在），不算失败。
 *
 * 用法：node scripts/route-sweep.js
 */

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SERVER_SRC = path.join(ROOT, "src", "server.js");
const PORT = 8600 + Math.floor(Math.random() * 200);
const BASE = "http://127.0.0.1:" + PORT;
const ADMIN_TOKEN = "sweep-admin-token-0123456789abcdef";
const IP_SECRET = "sweep-ip-hash-secret-0123456789abcdef";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "wall-sweep-"));
const DB_PATH = path.join(TMP, "sweep.db");

/* ── 1. 从源码里抠出全部路由 ─────────────────────────────────────────── */

function extractRoutes() {
  const src = fs.readFileSync(SERVER_SRC, "utf8");
  const re = /route\(\s*"([A-Z]+)"\s*,\s*(?:"([^"]+)"|`([^`]+)`)/g;
  const out = [];
  let match;
  while ((match = re.exec(src)) !== null) {
    const method = match[1];
    let pattern = match[2] || match[3];
    // 模板字面量路由（循环注册的那种）：把 ${x} 展开成一个具体取值
    pattern = pattern.replace(/\$\{\s*action\s*\}/g, "approve");
    pattern = pattern.replace(/\$\{[^}]+\}/g, "1");
    out.push({ method, pattern });
  }
  return out;
}

const routes = extractRoutes();

/* ── 2. 把 pattern 变成可请求的 URL ──────────────────────────────────── */

function materialize(pattern, context) {
  return pattern
    .replace(/:id/g, "1")
    .replace(/:uuid/g, context.uuid)
    .replace(/:action/g, "approve");
}

const SKIP = new Set(["POST /api/admin/shutdown"]); // 会真的把服务关掉

/* ── 3. 起服务 ───────────────────────────────────────────────────────── */

const server = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], {
  cwd: ROOT,
  env: {
    ...process.env,
    OD_SKIP_ENV_FILE: "1",
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: String(PORT),
    DB_PATH,
    OUTBOX_DIR: path.join(TMP, "outbox"),
    ADMIN_TOKEN,
    IP_HASH_SECRET: IP_SECRET,
    AUTH_CODE_ECHO: "1",
    FORCE_HTTPS: "0"
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
      if ((await fetch(BASE + "/api/health")).ok) return;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("服务未能在 20 秒内启动\n" + serverLog);
}

/** 造一份最小可用数据：一所学校 + 一个已登录用户 */
async function seed() {
  const jar = new Map();
  const call = async (method, url, body, admin) => {
    const headers = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (admin) headers.authorization = "Bearer " + ADMIN_TOKEN;
    if (jar.size) headers.cookie = Array.from(jar).map(([k, v]) => k + "=" + v).join("; ");
    const res = await fetch(BASE + url, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body)
    });
    const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const line of cookies) {
      const pair = line.split(";")[0];
      const idx = pair.indexOf("=");
      if (idx < 0) continue;
      jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
    const text = await res.text();
    try { return { status: res.status, body: text ? JSON.parse(text) : null }; }
    catch { return { status: res.status, body: null }; }
  };

  await call("POST", "/api/admin/schools", { name: "巡检大学" }, true);
  const code = await call("POST", "/api/auth/code", { email: "sweep@example.com" });
  const verified = await call("POST", "/api/auth/verify", { email: "sweep@example.com", code: code.body.devCode });
  const registered = await call("POST", "/api/auth/register", {
    token: verified.body.token, nickname: "巡检员", school: "巡检大学"
  });

  return { call, uuid: registered.body && registered.body.user ? registered.body.user.uuid : "00000000-0000-0000-0000-000000000000" };
}

/* ── 4. 逐条打 ───────────────────────────────────────────────────────── */

async function main() {
  await waitForServer();
  const ctx = await seed();

  console.log(`路由巡检：共 ${routes.length} 条注册路由（跳过 ${SKIP.size} 条）\n`);

  let okCount = 0;
  let bad = 0;
  const failures = [];

  for (const { method, pattern } of routes) {
    const key = method + " " + pattern;
    if (SKIP.has(key)) {
      console.log(`  – ${key}（显式跳过）`);
      continue;
    }

    const url = materialize(pattern, ctx);
    const isAdmin = url.startsWith("/api/admin/");
    const needsBody = method === "POST" || method === "PATCH";

    let result;
    try {
      result = await ctx.call(method, url, needsBody ? {} : undefined, isAdmin);
    } catch (err) {
      result = { status: 0, body: String(err && err.message) };
    }

    // 5xx = 服务器自己的问题（我们只关心这个）；4xx 是正常的业务拒绝
    if (result.status >= 500 || result.status === 0) {
      bad += 1;
      failures.push(`${method} ${url} → ${result.status} ${JSON.stringify(result.body).slice(0, 120)}`);
      console.log(`  ✗ ${key} → ${result.status}`);
    } else {
      okCount += 1;
      console.log(`  ✓ ${key.padEnd(42)} ${result.status}`);
    }
  }

  console.log(`\n=== 无 5xx：${okCount} / ${okCount + bad} ===`);
  if (bad) {
    console.log("以下路由返回了 5xx：");
    failures.forEach((line) => console.log("  " + line));
    console.log("\n服务端日志（尾部）：\n" + serverLog.split("\n").slice(-30).join("\n"));
  }

  cleanup();
  process.exit(bad ? 1 : 0);
}

main().catch((err) => {
  console.error("巡检崩溃：" + ((err && err.stack) || err));
  console.log(serverLog.split("\n").slice(-30).join("\n"));
  cleanup();
  process.exit(1);
});
