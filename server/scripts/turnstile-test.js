"use strict";

/**
 * Turnstile 集成测试。
 *
 * 不用真实 Cloudflare：起一个本地假 siteverify，按 token 返回不同结果，
 * 这样「action 不匹配」「hostname 不在白名单」「服务端说失败」这些分支都能被确定性地测到。
 * 真实密钥的连通性由 scripts/turnstile-live-check.mjs 单独验证（需要外网）。
 *
 * 用法：node scripts/turnstile-test.js
 */

const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const APP_PORT = 9100 + Math.floor(Math.random() * 90);
const MOCK_PORT = 9300 + Math.floor(Math.random() * 90);
const BASE = "http://127.0.0.1:" + APP_PORT;
const MOCK = "http://127.0.0.1:" + MOCK_PORT;
const ADMIN_TOKEN = "turnstile-admin-token-0123456789abcdef";
const IP_SECRET = "turnstile-ip-secret-0123456789abcdef";
const SITE_KEY = "test-site-key";
const SECRET = "test-secret";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "wall-turnstile-"));
let passed = 0;
let failed = 0;
const failures = [];
const ok = (name, cond, detail) => {
  if (cond) { passed += 1; console.log("  ✓ " + name); }
  else { failed += 1; failures.push(name); console.log("  ✗ " + name + (detail === undefined ? "" : "  → " + JSON.stringify(detail))); }
};
const eq = (name, a, b) => ok(name, a === b, { actual: a, expected: b });

/* ── 假 siteverify ───────────────────────────────────────────────────── */

const seen = [];
const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += String(c); });
  req.on("end", () => {
    const form = new URLSearchParams(body);
    const token = form.get("response") || "";
    seen.push({ token, secret: form.get("secret"), remoteip: form.get("remoteip") });

    const reply = (payload, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (token === "good") return reply({ success: true, action: "login", hostname: "wall.example.com" });
    if (token === "wrong-action") return reply({ success: true, action: "signup", hostname: "wall.example.com" });
    if (token === "wrong-host") return reply({ success: true, action: "login", hostname: "evil.example.com" });
    if (token === "http-500") return reply({ success: true, action: "login", hostname: "wall.example.com" }, 500);
    return reply({ success: false, "error-codes": ["invalid-input-response"] });
  });
});

/* ── 被测服务 ───────────────────────────────────────────────────────── */

function spawnApp(extraEnv) {
  return spawn(process.execPath, [path.join(ROOT, "src", "server.js")], {
    cwd: ROOT,
    env: Object.assign({
      ...process.env,
      OD_SKIP_ENV_FILE: "1",
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(APP_PORT),
      DB_PATH: path.join(TMP, "t.db"),
      OUTBOX_DIR: path.join(TMP, "outbox"),
      ADMIN_TOKEN,
      IP_HASH_SECRET: IP_SECRET,
      AUTH_CODE_ECHO: "1",
      FORCE_HTTPS: "0",
      TURNSTILE_SITE_KEY: SITE_KEY,
      TURNSTILE_SECRET_KEY: SECRET,
      TURNSTILE_HOSTNAMES: "wall.example.com",
      TURNSTILE_ACTION: "login",
      TURNSTILE_VERIFY_URL: MOCK + "/siteverify"
    }, extraEnv || {}),
    stdio: ["ignore", "pipe", "pipe"]
  });
}

const app = spawnApp({});
let log = "";
app.stdout.on("data", (c) => { log += String(c); });
app.stderr.on("data", (c) => { log += String(c); });

async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(BASE + "/api/health")).ok) return true; } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function post(url, body) {
  let res;
  try {
    res = await fetch(BASE + url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (err) {
    console.error("post 失败 " + url + " → " + err.message
      + " / cause=" + JSON.stringify((err.cause && err.cause.code) || (err.cause && err.cause.message) || err.cause));
    console.error("app log tail: " + log.split("\n").slice(-10).join(" | "));
    throw err;
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}
function cleanup() {
  try { app.kill(); } catch { /* ignore */ }
  try { mock.close(); } catch { /* ignore */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}

/* ── 用例 ───────────────────────────────────────────────────────────── */

(async function main() {
  await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));
  if (!(await waitForServer())) throw new Error("被测服务未启动\n" + log);

  console.log("\n站点配置下发");
  const site = await (await fetch(BASE + "/api/site")).json();
  ok("只下发 siteKey 与 action（secret 永不出现在前端）",
    site.turnstile && site.turnstile.siteKey === SITE_KEY && site.turnstile.action === "login"
    && !JSON.stringify(site).includes(SECRET), site.turnstile);

  console.log("\n发码接口的人机验证");
  eq("不带 token 直接拒（400）", (await post("/api/auth/code", { email: "a@example.com" })).status, 400);
  const missing = await post("/api/auth/code", { email: "a@example.com" });
  eq("错误码是 turnstile_required", missing.body.error, "turnstile_required");

  const bad = await post("/api/auth/code", { email: "a@example.com", turnstileToken: "fail" });
  eq("Cloudflare 说失败 → 403", bad.status, 403);
  eq("错误码是 turnstile_failed", bad.body.error, "turnstile_failed");
  eq("原因透传给调用方（便于排查）", bad.body.reason, "invalid-input-response");

  const wrongAction = await post("/api/auth/code", { email: "a@example.com", turnstileToken: "wrong-action" });
  eq("action 不匹配 → 403", wrongAction.status, 403);
  eq("原因标明 action_mismatch", wrongAction.body.reason, "action_mismatch");

  const wrongHost = await post("/api/auth/code", { email: "a@example.com", turnstileToken: "wrong-host" });
  eq("hostname 不在白名单 → 403", wrongHost.status, 403);
  eq("原因标明 hostname_mismatch", wrongHost.body.reason, "hostname_mismatch");

  const http500 = await post("/api/auth/code", { email: "a@example.com", turnstileToken: "http-500" });
  eq("siteverify 返回 5xx → 拒绝（fail-closed）", http500.status, 403);

  const good = await post("/api/auth/code", { email: "good@example.com", turnstileToken: "good" });
  eq("校验通过 → 正常发码（200）", good.status, 200);
  ok("发码成功时回带验证码（AUTH_CODE_ECHO 测试开关）", /^\d{6}$/.test(good.body.devCode || ""), good.body);

  console.log("\n发给 Cloudflare 的请求形状");
  const last = seen[seen.length - 1] || {};
  eq("带上 secret", last.secret, SECRET);
  eq("带上 response", last.token, "good");
  ok("带上 remoteip（便于 Cloudflare 风控）", Boolean(last.remoteip), last.remoteip);

  console.log("\n配置缺失时的失败方式");
  // 换个端口起第二个实例：hostname 白名单为空
  const app2Port = APP_PORT + 1;
  const app2 = spawnApp({ PORT: String(app2Port), TURNSTILE_HOSTNAMES: "", DB_PATH: path.join(TMP, "t2.db") });
  let log2 = "";
  app2.stdout.on("data", (c) => { log2 += String(c); });
  app2.stderr.on("data", (c) => { log2 += String(c); });
  let up2 = false;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { if ((await fetch("http://127.0.0.1:" + app2Port + "/api/health")).ok) { up2 = true; break; } } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  ok("白名单为空的实例也能起来（不会崩）", up2, log2);
  if (up2) {
    const res = await fetch("http://127.0.0.1:" + app2Port + "/api/auth/code", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "b@example.com", turnstileToken: "good" })
    });
    const body = await res.json();
    eq("白名单为空 → 503（配置没配完，不能放行）", res.status, 503);
    eq("错误码是 turnstile_misconfigured", body.error, "turnstile_misconfigured");
  }
  try { app2.kill(); } catch { /* ignore */ }

  console.log("\n=== 通过 " + passed + " / 失败 " + failed + " ===");
  if (failed) {
    console.log("失败项：" + failures.join("、"));
    console.log(log.split("\n").slice(-20).join("\n"));
  }
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error("测试崩溃：" + ((err && err.stack) || err));
  console.log(log.split("\n").slice(-25).join("\n"));
  cleanup();
  process.exit(1);
});
