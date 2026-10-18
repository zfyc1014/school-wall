"use strict";

/**
 * 安全测试套件（审计回归）。
 *
 * 覆盖的攻击面：
 *   1. SQL 注入 —— 在所有接受查询参数/路径参数的接口上打载荷，验证被当作**数据**处理
 *      （本项目全部使用绑定参数，动态 SQL 片段来自常量白名单；这里把它们钉死）
 *   2. 路径穿越 / 敏感文件泄露 —— 含编码、双编码、反斜杠、空字节变体
 *   3. 反向代理头伪造 —— X-Forwarded-For 绕过按 IP 的限流（审计出来的真实高危）
 *   4. 存储型 XSS —— 首页 Markdown 与正文里的 <script>/javascript: 链接
 *   5. 协议健壮性 —— 畸形百分号编码、畸形 Cookie、超大请求体、非法 JSON
 *   6. 鉴权边界 —— 未授权管理接口、CSRF（仅 Cookie 不足以改管理资源）、IDOR（私信）
 *   7. 安全响应头与 Cookie 属性
 *   8. 限流器内存上限（防「海量唯一键」内存耗尽）
 *
 * 用法：node scripts/security-test.js
 * 端口用随机区间，避免与其它套件打架。
 */

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
const REPO = path.join(ROOT, "..");
const ADMIN_TOKEN = "security-admin-token-0123456789abcdef";
const IP_SECRET = "security-ip-secret-0123456789abcdef";

let passed = 0;
let failed = 0;
const failures = [];
const ok = (name, cond, detail) => {
  if (cond) { passed += 1; console.log("  ✓ " + name); }
  else { failed += 1; failures.push(name); console.log("  ✗ " + name + (detail === undefined ? "" : "  → " + JSON.stringify(detail))); }
};
const eq = (name, a, b) => ok(name, a === b, { actual: a, expected: b });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 起一个被测实例 ─────────────────────────────────────────────────── */

function startApp(extra, portBase) {
  const port = (portBase || 9800) + Math.floor(Math.random() * 150);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wall-sec-"));
  const child = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], {
    cwd: ROOT,
    env: Object.assign({
      ...process.env,
      OD_SKIP_ENV_FILE: "1",
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      DB_PATH: path.join(tmp, "sec.db"),
      OUTBOX_DIR: path.join(tmp, "outbox"),
      ADMIN_TOKEN,
      IP_HASH_SECRET: IP_SECRET,
      AUTH_CODE_ECHO: "1",
      FORCE_HTTPS: "0",
      BOT_GUARD: "0"
    }, extra || {}),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let log = "";
  child.stdout.on("data", (c) => { log += String(c); });
  child.stderr.on("data", (c) => { log += String(c); });
  return { child, tmp, port, base: "http://127.0.0.1:" + port, log: () => log };
}

async function waitUp(base) {
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch(base + "/api/health")).ok) return true; } catch { /* 等 */ }
    await sleep(100);
  }
  return false;
}

function stopApp(app) {
  try { app.child.kill(); } catch { /* ignore */ }
  try { fs.rmSync(app.tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

/* ── 小工具 ─────────────────────────────────────────────────────────── */

const jars = new Map();
function client() {
  const jar = new Map();
  const call = async (method, url, { body, admin, headers } = {}) => {
    const h = Object.assign({}, headers || {});
    if (body !== undefined) h["content-type"] = "application/json";
    if (admin && !h.authorization) h.authorization = "Bearer " + ADMIN_TOKEN;
    if (jar.size) h.cookie = Array.from(jar).map(([k, v]) => k + "=" + v).join("; ");
    const res = await fetch(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const line of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
      const pair = line.split(";")[0];
      const i = pair.indexOf("=");
      if (i > 0) jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    return { status: res.status, body: json, headers: res.headers, setCookie: (res.headers.getSetCookie ? res.headers.getSetCookie() : []).join("; ") };
  };
  return {
    jar,
    get: (p, o) => call("GET", p, o),
    post: (p, b, o) => call("POST", p, Object.assign({ body: b === undefined ? {} : b }, o)),
    del: (p, o) => call("DELETE", p, o)
  };
}

async function registerUser(base, email, nickname) {
  const c = client();
  const code = await c.post(base + "/api/auth/code", { email });
  const verified = await c.post(base + "/api/auth/verify", { email, code: code.body.devCode });
  const reg = await c.post(base + "/api/auth/register", { token: verified.body.token, nickname, school: "测试大学" });
  return { client: c, user: reg.body.user, reg };
}

/* ── 用例 ───────────────────────────────────────────────────────────── */

(async () => {
  const app = startApp({ TRUST_PROXY: "" }, 9800);
  if (!(await waitUp(app.base))) throw new Error("实例未启动\n" + app.log().slice(-800));
  const base = app.base;
  const anon = client();

  try {
    /* ── 1. 安全响应头 ── */
    console.log("\n安全响应头");
    const home = await anon.get(base + "/");
    const csp = home.headers.get("content-security-policy") || "";
    ok("CSP 存在", csp.length > 20, csp.slice(0, 60));
    ok("CSP 的 script-src 不含 unsafe-inline（除构建产物缺失时的兜底）",
      !/script-src[^;]*unsafe-inline/.test(csp), csp);
    ok("CSP 含内联脚本哈希或为兜底", /sha256-/.test(csp) || /script-src[^;]*unsafe-inline/.test(csp), csp.slice(0, 120));
    ok("CSP 含 object-src none 与 frame-ancestors none", csp.includes("object-src 'none'") && csp.includes("frame-ancestors 'none'"), csp);
    eq("X-Content-Type-Options", home.headers.get("x-content-type-options"), "nosniff");
    eq("X-Frame-Options", home.headers.get("x-frame-options"), "DENY");
    eq("Cross-Origin-Resource-Policy", home.headers.get("cross-origin-resource-policy"), "same-origin");
    eq("Referrer-Policy", home.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
    ok("后台页面单独允许内联脚本（单文件控制台）",
      /script-src[^;]*unsafe-inline/.test((await anon.get(base + "/houtai/")).headers.get("content-security-policy") || ""));

    /* ── 2. 路径穿越 / 敏感文件 ── */
    console.log("\n路径穿越与敏感文件");
    const traversals = [
      "/server/.env", "/.git/config", "/server/data/wall.db", "/../server/.env",
      "/%2e%2e/server/.env", "/%2E%2E%2Fserver%2F.env", "/..%2fserver%2f.env",
      "/%252e%252e%252fserver%252f.env", "/server/../server/.env", "/\\..\\server\\.env"
    ];
    for (const p of traversals) {
      const r = await fetch(base + p, { redirect: "manual" });
      const text = await r.text();
      ok("穿越被拒 " + p, r.status >= 400 && !text.includes("ADMIN_TOKEN") && !text.includes("SQLite format"),
        { status: r.status, head: text.slice(0, 30) });
    }
    eq("畸形百分号编码 → 400", (await fetch(base + "/%")).status, 400);
    eq("非法百分号编码 → 400", (await fetch(base + "/%zz")).status, 400);
    ok("畸形 Cookie 不产生 5xx", (await fetch(base + "/api/auth/me", { headers: { cookie: "od_session=%E0%A4%A" } })).status < 500);

    /* ── 3. 协议健壮性 ── */
    console.log("\n协议健壮性");
    eq("超大请求体 → 413", (await anon.post(base + "/api/auth/code", { email: "a@example.com", pad: "x".repeat(80000) })).status, 413);
    const badJson = await fetch(base + "/api/auth/code", { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
    eq("非法 JSON → 400", badJson.status, 400);
    eq("静态资源不接受 POST", (await fetch(base + "/", { method: "POST" })).status, 405);

    /* ── 4. 准备数据（学校/用户/帖子） ── */
    await anon.post(base + "/api/admin/schools", { name: "测试大学" }, { admin: true });
    const alice = await registerUser(base, "alice@example.com", "爱丽丝");
    const bob = await registerUser(base, "bob@example.com", "鲍勃");
    const carol = await registerUser(base, "carol@example.com", "卡罗");
    eq("测试用户注册成功", alice.reg.status, 201);
    const post = await alice.client.post(base + "/api/posts", { cat: "表白", body: "第一条公开内容" });
    eq("测试帖子直接发布", post.body.status, "approved");

    /* ── 5. SQL 注入载荷 ── */
    console.log("\nSQL 注入（全部应被当作数据）");
    const payloads = [
      "' OR '1'='1",
      "'; DROP TABLE posts; --",
      "1' UNION SELECT 1,2,3 --",
      "%' OR 1=1 --",
      "_' OR '1'='1' --",
      "\" OR 1=1 --",
      "admin'--"
    ];
    let sqliClean = true;
    for (const payload of payloads) {
      const qs = "?q=" + encodeURIComponent(payload);
      const feed = await anon.get(base + "/api/posts" + qs);
      if (feed.status !== 200 || !Array.isArray(feed.body.items)) sqliClean = false;
      const users = await anon.get(base + "/api/admin/users" + qs, { admin: true });
      if (users.status !== 200 || !Array.isArray(users.body.items)) sqliClean = false;
      const queue = await anon.get(base + "/api/admin/queue?type=posts&q=" + encodeURIComponent(payload), { admin: true });
      if (queue.status !== 200) sqliClean = false;
      const audit = await anon.get(base + "/api/admin/audit?action=" + encodeURIComponent(payload), { admin: true });
      if (audit.status !== 200) sqliClean = false;
      const reports = await anon.get(base + "/api/admin/reports?status=" + encodeURIComponent(payload), { admin: true });
      if (reports.status !== 200) sqliClean = false;
      const forum = await anon.get(base + "/api/forum/threads?board=" + encodeURIComponent(payload));
      if (forum.status !== 200) sqliClean = false;
    }
    ok("7 组注入载荷在 6 个接口上均不报错、返回合法结构", sqliClean);

    const normal = await anon.get(base + "/api/posts?q=" + encodeURIComponent("第一条"));
    eq("正常搜索仍能命中（说明过滤没把功能搞坏）", normal.body.items.length, 1);
    const wildcard = await anon.get(base + "/api/posts?q=" + encodeURIComponent("%"));
    eq("LIKE 通配符被转义（% 不再匹配全部）", wildcard.body.items.length, 0);
    const underscore = await anon.get(base + "/api/posts?q=" + encodeURIComponent("_"));
    eq("LIKE 下划线通配符被转义", underscore.body.items.length, 0);
    eq("分类参数走白名单（注入串被丢弃而不是拼进 SQL）",
      (await anon.get(base + "/api/posts?cat=" + encodeURIComponent("表白' OR 1=1 --"))).body.items.length, 1);
    ok("路径参数注入不产生 5xx",
      (await anon.get(base + "/api/posts/" + encodeURIComponent("1 OR 1=1"))).status < 500);
    ok("用户路径参数注入返回 404",
      (await anon.get(base + "/api/users/" + encodeURIComponent("' OR '1'='1"))).status === 404);
    ok("游标参数非法值不报错",
      (await anon.get(base + "/api/posts?cursor=" + encodeURIComponent("1;DROP TABLE posts"))).status === 200);
    // 注入尝试后数据库仍完好
    eq("注入尝试后数据表仍在（帖子数仍为 1）", (await anon.get(base + "/api/posts")).body.items.length, 1);

    // 正文里的 SQL 载荷按数据存储
    const injected = await alice.client.post(base + "/api/posts", { cat: "表白", body: "'; DROP TABLE posts; --" });
    const feedAfter = await anon.get(base + "/api/posts");
    ok("正文里的 SQL 载荷原样保存为数据",
      feedAfter.body.items.some((it) => it.body === "'; DROP TABLE posts; --"), feedAfter.body.items.length);

    /* ── 6. 存储型 XSS（渲染器单测 + 接口行为） ── */
    console.log("\nXSS");
    const mdPath = pathToFileURL(path.join(REPO, "web", "src", "lib", "markdown.js")).href;
    const md = await import(mdPath);
    const renderMarkdown = md.renderMarkdown || md.default;
    const outScript = renderMarkdown("<script>alert(1)</script>");
    ok("Markdown 渲染：<script> 被转义", !/<script/i.test(outScript) && outScript.includes("&lt;script&gt;"), outScript.slice(0, 80));
    const outHref = renderMarkdown("[点我](javascript:alert(1))");
    ok("Markdown 渲染：javascript: 链接被剥离", !/javascript:/i.test(outHref) && outHref.includes("点我"), outHref.slice(0, 80));
    const outImg = renderMarkdown("![x](http://evil.example/a.png)");
    ok("Markdown 渲染：不渲染外链图片（防追踪/防注入）", !/<img/i.test(outImg), outImg.slice(0, 80));
    const outInline = renderMarkdown("\`<b>bold</b>\`");
    ok("Markdown 渲染：行内代码内的标签被转义", !/<b>/i.test(outInline), outInline.slice(0, 80));
    const outAttr = renderMarkdown('<a href="x" onmouseover="alert(1)">y</a>');
    ok("Markdown 渲染：标签与属性都被转义成文本（不会产生真实标签）",
      !/<a[\s>]/i.test(outAttr) && outAttr.includes("&lt;a"), outAttr.slice(0, 90));

    const saved = await anon.post(base + "/api/admin/home", {
      markdown: "<script>alert(1)</script>\n\n[坏链接](javascript:alert(1))"
    }, { admin: true });
    eq("首页可保存（内容按原始 Markdown 存储）", saved.status, 200);
    const homeAfter = await anon.get(base + "/api/home");
    ok("首页接口返回的是 Markdown 原文（由前端安全渲染）",
      String(homeAfter.body.markdown).includes("<script>alert(1)</script>"), String(homeAfter.body.markdown).slice(0, 40));
    const rendered = renderMarkdown(homeAfter.body.markdown);
    ok("渲染后的首页不含可执行脚本", !/<script/i.test(rendered) && !/javascript:/i.test(rendered), rendered.slice(0, 100));

    /* ── 7. 鉴权边界 / CSRF / IDOR ── */
    console.log("\n鉴权边界");
    eq("未授权访问管理接口 → 401", (await anon.get(base + "/api/admin/stats")).status, 401);
    eq("错误的 Admin Token → 401",
      (await anon.get(base + "/api/admin/stats", { admin: true, headers: { authorization: "Bearer wrong-token-0123456789" } })).status, 401);
    // CSRF：仅凭会话 Cookie 不足以修改管理资源（管理接口只认 Bearer / X-Admin-Token）
    const csrfTry = await alice.client.post(base + "/api/admin/home", { markdown: "# 被篡改" });
    eq("仅用登录 Cookie 调管理接口 → 401（管理接口不吃 Cookie）", csrfTry.status, 401);
    // IDOR：私信只在自己的会话里可见
    const pair = await alice.client.post(base + "/api/friends/requests", { uuid: bob.user.uuid });
    eq("A 向 B 发好友请求（201）", pair.status, 201);
    await bob.client.post(base + "/api/friends/requests/" + alice.user.uuid + "/accept", {});
    await alice.client.post(base + "/api/dm/" + bob.user.uuid, { body: "只有 A 和 B 能看到" });
    const carolView = await carol.client.get(base + "/api/dm/" + bob.user.uuid);
    ok("第三方打开私信会话看不到别人的消息",
      carolView.status === 200 && !JSON.stringify(carolView.body).includes("只有 A 和 B 能看到"), carolView.status);
    ok("未登录读私信 → 401", (await anon.get(base + "/api/dm/" + bob.user.uuid)).status === 401);

    /* ── 8. Cookie 属性 ── */
    console.log("\nCookie 属性");
    const loginCode = await client().post(base + "/api/auth/code", { email: "alice@example.com" });
    const login = await anon.post(base + "/api/auth/verify", { email: "alice@example.com", code: loginCode.body.devCode });
    const setCookie = login.setCookie || "";
    ok("会话 Cookie 带 HttpOnly", /HttpOnly/i.test(setCookie), setCookie);
    ok("会话 Cookie 带 SameSite=Lax", /SameSite=Lax/i.test(setCookie), setCookie);
    ok("会话 Cookie 带 Path=/", /Path=\//i.test(setCookie), setCookie);

    /* ── 9. XFF 伪造（限流绕过） ── */
    console.log("\n反向代理头伪造");
    let limited = false;
    const seen = [];
    for (let i = 0; i < 15; i += 1) {
      const r = await anon.get(base + "/api/admin/stats", {
        headers: { authorization: "Bearer wrong-token", "x-forwarded-for": "203.0.113." + (i + 1) }
      });
      seen.push(r.status);
      if (r.status === 429) { limited = true; break; }
    }
    ok("不信任转发头时：伪造 XFF 不能绕过后台令牌限流", limited, seen);

    stopApp(app);

    // 实例 2：TRUST_PROXY=1 但只信任 10/8（模拟「应用可被直连、反代在内网」）
    const app2 = startApp({ TRUST_PROXY: "1", TRUST_PROXY_IPS: "10.0.0.0/8" }, 9950);
    if (!(await waitUp(app2.base))) throw new Error("实例 2 未启动\n" + app2.log().slice(-600));
    let limited2 = false;
    const seen2 = [];
    for (let i = 0; i < 15; i += 1) {
      const r = await anon.get(app2.base + "/api/admin/stats", {
        headers: { authorization: "Bearer wrong-token", "x-forwarded-for": "203.0.113." + (i + 1) }
      });
      seen2.push(r.status);
      if (r.status === 429) { limited2 = true; break; }
    }
    ok("非可信对端（直连）伪造 XFF 依然被限流", limited2, seen2);
    stopApp(app2);

    // 实例 3：可信代理（环回）→ 取 XFF 最右一跳
    const app3 = startApp({ TRUST_PROXY: "1", TRUST_PROXY_IPS: "127.0.0.0/8" }, 9600);
    if (!(await waitUp(app3.base))) throw new Error("实例 3 未启动\n" + app3.log().slice(-600));
    let shared = false;
    for (let i = 0; i < 15; i += 1) {
      const r = await anon.get(app3.base + "/api/admin/stats", {
        headers: { authorization: "Bearer wrong", "x-forwarded-for": "1.1.1." + (i + 1) + ", 198.51.100.7" }
      });
      if (r.status === 429) { shared = true; break; }
    }
    ok("可信代理下取 XFF 最右一跳：左侧伪造不改变限流身份", shared);
    const other = await anon.get(app3.base + "/api/admin/stats", {
      headers: { authorization: "Bearer wrong", "x-forwarded-for": "198.51.100.99" }
    });
    eq("不同的真实客户端有独立限流桶", other.status, 401);
    stopApp(app3);

    /* ── 10. 限流器内存上限（单元级） ── */
    console.log("\n限流器内存上限");
    const unitScript = [
      'process.env.RATE_LIMIT_MAX_KEYS = "200";',
      'const rl = require(' + JSON.stringify(path.join(ROOT, "src", "rate-limit.js")) + ');',
      'for (let i = 0; i < 2000; i += 1) rl.limit("k" + i, 1, 60000);',
      'console.log(JSON.stringify({ size: rl.size(), max: rl.maxBuckets }));'
    ].join("\n");
    const unit = spawnSync(process.execPath, ["-e", unitScript], { encoding: "utf8" });
    let unitState = { size: -1, max: -1 };
    try { unitState = JSON.parse(unit.stdout.trim()); } catch { /* ignore */ }
    ok("海量唯一键不会让限流表无限增长", unitState.size > 0 && unitState.size <= unitState.max, unitState);
  } finally {
    stopApp(app);
  }

  console.log("\n=== 通过 " + passed + " / 失败 " + failed + " ===");
  if (failed) console.log("失败项：" + failures.join("、"));
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error("安全测试崩溃：" + ((err && err.stack) || err));
  process.exit(1);
});
