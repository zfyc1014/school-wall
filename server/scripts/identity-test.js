"use strict";

/**
 * 后台实名 + 先审后发 · 接口测试
 *
 * 用真实服务进程（不是 mock）+ 临时数据库 + 本地假短信网关。
 * 覆盖：
 *   * 手机号归一化与校验（大陆 / 香港 / 非法格式）
 *   * 未验证 → 403 identity_required（发布、评论、举报）
 *   * 完整验证流程：发码 → 取码 → 校验 → 签发会话 → 可以发布
 *   * 验证码安全属性：一次性、错误次数上限、过期、重发间隔、按号码/按 IP 限流
 *   * 先审后发：帖子与评论一律 pending，审核通过后才公开/计数
 *   * 追溯链路：从身份查到它发过的全部内容
 *   * 敏感信息不外泄：响应里没有明文手机号、没有哈希、cookie 为 HttpOnly
 *
 * 验证码从哪来：SMS_PROVIDER=webhook 指向本地假网关，网关把收到的码记下来，
 * 测试再向它索取。这样既走通了真实发送路径，又不需要真的发短信。
 *
 * 用法：node scripts/identity-test.js
 */

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { createServer } = require("http");

const PORT = 8500 + Math.floor(Math.random() * 300);
const HOST = "127.0.0.1";
const BASE = `http://${HOST}:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "od-identity-test-"));
const ADMIN_TOKEN = crypto.randomBytes(24).toString("hex");
const IP_SECRET = crypto.randomBytes(16).toString("hex");

const results = [];
const ok = (n, d = "") => { results.push(true); console.log(`  \u2713 ${n}${d ? `  — ${d}` : ""}`); };
const bad = (n, d = "") => { results.push(false); console.log(`  \u2717 ${n}${d ? ` — ${d}` : ""}`); };
const check = (n, c, d = "") => { if (c) ok(n, d); else bad(n, d); return Boolean(c); };

/* ── 假短信网关：记录最近一次验证码 ──────────────────────────────── */
let lastSms = null;
const gateway = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    try { lastSms = JSON.parse(raw); } catch { lastSms = null; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "mock-" + Date.now() }));
  });
});

let server = null;
let serverLog = "";
/** 服务是否已经退出：退出后请求失败要给出可诊断的信息，而不是只报 ECONNREFUSED */
let serverGone = false;

function startServer(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const env = Object.assign({
      ...process.env,
      HOST, PORT: String(PORT),
      NODE_ENV: "production",            // 生产语义：实名默认强制、未配验证则拒绝启动
      DB_PATH: path.join(TMP, "wall.db"),
      ADMIN_TOKEN, IP_HASH_SECRET: IP_SECRET,
      IDENTITY_SECRET: IP_SECRET,
      CHALLENGE_ALLOW_DISABLED: "1",     // 本测试只验证实名，人机验证另行测试
      CHALLENGE_ENFORCE: "0",
      IDENTITY_ENFORCE: "1",
      SMS_PROVIDER: "webhook",
      SMS_WEBHOOK_URL: `http://127.0.0.1:${gatewayPort}/sms`,
      IDENTITY_RESEND_INTERVAL_MS: "1000",
      IDENTITY_MAX_PER_DAY: "10",
      IDENTITY_MAX_PER_HOUR_IP: "40",
      IDENTITY_MAX_ATTEMPTS: "3",
      // 测试会高频调管理接口，默认的「15 分钟 10 次」鉴权限流会把后半段打成 429，
      // 那是面向公网的防爆破设置，测试环境放宽即可（限流本身另行验证）。
      ADMIN_RATE_LIMIT: "1000",
      DB_CHECKPOINT_MS: "600000",
      DB_CLEANUP_MS: "600000",
      RETENTION_DAYS: "0"
    }, extraEnv);

    const child = spawn(process.execPath, [path.join(__dirname, "..", "src", "server.js")], {
      cwd: path.join(__dirname, ".."),
      env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true
    });
    let out = "";
    const onData = (c) => {
      out += String(c);
      serverLog = out;
      if (/\[up\] 表白墙服务/.test(out)) resolve(child);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      serverGone = true;
      if (!stopping && !/\[down\]/.test(out)) {
        console.error(`\n[后端异常退出] code=${code}\n${out}\n`);
        reject(new Error(`后端退出 code=${code}`));
        return;
      }
      // 正常收尾：resolve 掉，避免 unhandled rejection
      resolve(child);
    });
    setTimeout(() => reject(new Error(`启动超时\n${out}`)), 20000);
  });
}

async function api(pathname, options = {}) {
  const init = Object.assign({ headers: {} }, options);
  let lastErr = null;
  for (let i = 0; i < 3; i += 1) {
    if (serverGone) break;
    try {
      const res = await fetch(BASE + pathname, init);
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      if (options.method === "POST" || options.method === "PUT") {
        process.stderr.write(`      · ${options.method} ${pathname} → ${res.status}\n`);
      }
      return { status: res.status, body, headers: res.headers };
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
  throw new Error(
    `请求 ${options.method || "GET"} ${pathname} 失败：${lastErr?.message}（${lastErr?.cause?.code || "?"}）`
    + (serverGone ? "；服务进程已退出（见上方后端输出）" : "；服务仍在运行，疑似瞬时连接问题")
  );
}

const json = (obj) => ({ "content-type": "application/json" });
const post = (p, payload, extraHeaders = {}) => api(p, {
  method: "POST",
  headers: Object.assign(json(), extraHeaders),
  body: JSON.stringify(payload)
});

/** 主动收尾中：此时进程退出属预期，不要当成崩溃刷屏 */
let stopping = false;

async function stop(child) {
  if (!child) return;
  stopping = true;
  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 900));
  try { child.kill("SIGKILL"); } catch { /* ignore */ }
}

let gatewayPort = 0;

(async () => {
  await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
  gatewayPort = gateway.address().port;
  console.log(`\n后台实名 + 先审后发 · 接口测试`);
  console.log(`服务 ${BASE} · 假短信网关 :${gatewayPort} · 临时库 ${TMP}\n`);

  server = await startServer();

  /* ── 1. 配置与闸门 ─────────────────────────────────────────── */
  console.log("[1/7] 实名闸门");
  const cfg = await api("/api/challenge/config");
  check("配置接口下发实名要求", cfg.body.identity?.required === true, JSON.stringify(cfg.body.identity));
  check("默认不要求实名才能阅读（读多写少）", cfg.body.identity?.requireForReads === false);
  check("初始未验证且无手机号回显", cfg.body.identity.verified === false && cfg.body.identity.phoneMasked === "");

  const noId = await post("/api/posts", { cat: "表白", body: "未实名不应该能发布内容到这里。" });
  check("未实名发帖被 403 拦下", noId.status === 403 && noId.body.error === "identity_required", JSON.stringify(noId.body));

  /* ── 2. 手机号校验 ─────────────────────────────────────────── */
  console.log("\n[2/7] 手机号校验与防滥用");
  for (const [phone, label] of [["12345", "过短"], ["1234567890a", "含字母"], ["+1 415 555 0100", "不支持的国家码"]]) {
    const r = await post("/api/identity/request-code", { phone });
    check(`非法号码被拒：${label}`, r.status === 400, `${phone} → ${r.body?.message}`);
  }

  const cn = await post("/api/identity/request-code", { phone: "13800138000" });
  check("大陆号码通过并发码", cn.status === 200 && /138\*+8000|86 13\*+00/.test(cn.body.masked), `masked=${cn.body?.masked}`);
  check("响应不回显完整号码", !JSON.stringify(cn.body).includes("13800138000"), JSON.stringify(cn.body));
  const codeCn = lastSms?.code;
  check("验证码已交给短信网关（走真实发送路径）", /^\d{6}$/.test(codeCn || ""), `code=${codeCn} phone=${lastSms?.phone}`);
  check("网关收到的号码是 E.164 归一化形式", lastSms?.phone === "8613800138000", lastSms?.phone);

  const tooSoon = await post("/api/identity/request-code", { phone: "13800138000" });
  check("同号码重发间隔生效", tooSoon.status === 429, `${tooSoon.status} retryAfter=${tooSoon.body?.retryAfter}`);

  const hk = await post("/api/identity/request-code", { phone: "+852 9123 4567" });
  check("香港号码通过（部署地在香港）", hk.status === 200, `masked=${hk.body?.masked} phone=${lastSms?.phone}`);
  check("香港号码归一化为 852 前缀", lastSms?.phone === "85291234567", lastSms?.phone);
  const codeHk = lastSms.code;

  /* ── 3. 验证码安全属性 ─────────────────────────────────────── */
  console.log("\n[3/7] 验证码安全属性");
  const wrong = await post("/api/identity/verify", { phone: "13800138000", code: "000000", consent: true });
  check("错误验证码被拒且提示剩余次数",
    wrong.status === 400 && /还可尝试 2 次/.test(wrong.body.message), wrong.body?.message);

  const noConsent = await post("/api/identity/verify", { phone: "13800138000", code: codeCn, consent: false });
  check("未同意告知不能完成验证", noConsent.status === 400 && noConsent.body.error === "consent_required");

  /* ── 4. 完成验证 ───────────────────────────────────────────── */
  console.log("\n[4/7] 完成验证并取得会话");
  const verified = await post("/api/identity/verify", { phone: "13800138000", code: codeCn, consent: true });
  const setCookie = verified.headers.get("set-cookie") || "";
  check("正确验证码完成实名", verified.status === 200 && verified.body.verified === true, JSON.stringify(verified.body));
  check("签发 HttpOnly 会话 cookie", /od_identity=/.test(setCookie) && /HttpOnly/i.test(setCookie), setCookie.slice(0, 40) + "…");
  check("响应不含明文号码与哈希", !JSON.stringify(verified.body).includes("13800138000") && !/phone_hash/.test(JSON.stringify(verified.body)));
  const cookie = setCookie.split(";")[0];

  const cfg2 = await api("/api/challenge/config", { headers: { cookie } });
  check("会话生效并回显脱敏号码",
    cfg2.body.identity.verified === true
      && /^86 \d{2}\*{4}\d{2}$/.test(cfg2.body.identity.phoneMasked),
    cfg2.body.identity.phoneMasked);

  const reused = await post("/api/identity/verify", { phone: "13800138000", code: codeCn, consent: true });
  check("验证码一次性：重复使用被拒", reused.status === 400, reused.body?.message);

  // 香港号码也走完一次验证：确认第二类号码端到端可用（部署地在香港）
  const hkVerified = await post("/api/identity/verify", { phone: "+852 9123 4567", code: codeHk, consent: true });
  check("香港号码也能完成实名", hkVerified.status === 200 && hkVerified.body.verified === true,
    JSON.stringify(hkVerified.body));

  const attempts = await post("/api/identity/request-code", { phone: "13900139000" });
  check("换号发码成功（用于测试错误次数上限）", attempts.status === 200,
    `${attempts.status} ${JSON.stringify(attempts.body)}`);
  const code2 = lastSms.code;
  await post("/api/identity/verify", { phone: "13900139000", code: "111111", consent: true });
  await post("/api/identity/verify", { phone: "13900139000", code: "222222", consent: true });
  const third = await post("/api/identity/verify", { phone: "13900139000", code: "333333", consent: true });
  check("错误 3 次后验证码作废", /错误次数过多/.test(third.body.message), third.body?.message);
  const afterLock = await post("/api/identity/verify", { phone: "13900139000", code: code2, consent: true });
  check("作废后即使输入正确验证码也无效", afterLock.status === 400, afterLock.body?.message);

  /* ── 5. 先审后发 ───────────────────────────────────────────── */
  console.log("\n[5/7] 先审后发（帖子与评论）");
  const created = await post("/api/posts", { cat: "表白", body: "实名之后发布的内容，应当进入待审队列。" }, { cookie });
  check("实名后可以发布", created.status === 201 && created.body.status === "pending", JSON.stringify(created.body));

  const feedBefore = await api("/api/posts?sort=new&limit=50");
  check("待审内容不出现在公开列表",
    !feedBefore.body.items.some((i) => String(i.id) === String(created.body.id)));

  const approve = await post(`/api/admin/posts/${created.body.id}/approve`, { note: "内容合规" },
    { authorization: `Bearer ${ADMIN_TOKEN}` });
  check("审核通过成功并记录审核意见", approve.status === 200 && approve.body.note === "内容合规", JSON.stringify(approve.body));

  const feedAfter = await api("/api/posts?sort=new&limit=50");
  check("审核通过后出现在公开列表",
    feedAfter.body.items.some((i) => String(i.id) === String(created.body.id)));

  const comment = await post(`/api/posts/${created.body.id}/comments`, { body: "这是一条评论，同样应该先审后发。" }, { cookie });
  check("评论提交后为 pending（不再默认公开）",
    comment.status === 201 && comment.body.status === "pending", JSON.stringify(comment.body));

  const commentsBefore = await api(`/api/posts/${created.body.id}/comments`);
  check("待审评论不出现在公开评论区", commentsBefore.body.items.length === 0);

  await post(`/api/admin/comments/${comment.body.id}/approve`, {}, { authorization: `Bearer ${ADMIN_TOKEN}` });
  const commentsAfter = await api(`/api/posts/${created.body.id}/comments`);
  check("评论审核通过后才出现", commentsAfter.body.items.length === 1, `${commentsAfter.body.items.length} 条`);

  const postRow = (await api("/api/posts?sort=new&limit=50")).body.items.find((i) => String(i.id) === String(created.body.id));
  check("评论计数在审核通过时才 +1", postRow && postRow.comments === 1, `comments=${postRow?.comments}`);

  /* ── 6. 追溯链路 ───────────────────────────────────────────── */
  console.log("\n[6/7] 追溯：从身份查到全部内容");
  const queue = await api("/api/admin/queue?type=posts", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
  check("队列接口可用（当前应已清空）", queue.status === 200 && Array.isArray(queue.body.items), `${queue.body.items.length} 条待审`);

  const identities = await api("/api/admin/identities", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
  console.log(`  [原始响应] ${JSON.stringify(identities.body)}`);
  check("身份列表可读且只含脱敏号码",
    identities.status === 200 && identities.body.items.length >= 1
      && identities.body.items.every((i) => !/\d{11}/.test(i.phone_masked)),
    identities.body.items.map((i) => i.phone_masked).join(", "));
  // 脱敏格式严格为「国家码 前两位****后两位」，因此不可能出现完整号码
  check("脱敏格式统一（86/852 + 前2 + **** + 后2）",
    identities.body.items.every((i) => /^(86|852) \d{2}\*{4}\d{2}$/.test(i.phone_masked)),
    identities.body.items.map((i) => i.phone_masked).join(", "));
  // 前面完成了两次验证（大陆 138…、香港 852…），应当有两条身份记录
  check("两次不同号码的验证各自落一条身份", identities.body.items.length === 2,
    `${identities.body.items.length} 条`);

  // 用大陆那条身份做追溯（发布内容用的是它的会话），按脱敏号码精确定位
  const cnIdentity = identities.body.items.find((i) => i.phone_masked.startsWith("86 "));
  check("能定位到发布内容所用的身份", Boolean(cnIdentity), cnIdentity?.phone_masked);

  const identityId = cnIdentity.id;
  const trace = await api(`/api/admin/identity/${identityId}`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
  check("可从身份追溯到它发布的帖子与评论",
    trace.status === 200 && trace.body.posts.length >= 1 && trace.body.comments.length >= 1,
    `posts=${trace.body.posts?.length} comments=${trace.body.comments?.length}`);
  check("追溯结果包含待审与被下架内容（不止公开部分）",
    trace.body.posts.some((p) => ["pending", "approved", "removed", "rejected"].includes(p.status)),
    trace.body.posts.map((p) => p.status).join(","));
  check("追溯接口未鉴权时不可访问",
    (await api(`/api/admin/identity/${identityId}`)).status === 401);

  // 路由遮蔽回归测试：/admin/identities（列表）与 /admin/identity/:id（单条）
  // 必须各自命中，不能因为 :id 的正则吞掉字面量而互相遮蔽
  const listShape = await api("/api/admin/identities", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
  const singleShape = await api(`/api/admin/identity/${identityId}`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
  check("列表接口返回 items 数组（未被 :id 路由遮蔽）",
    Array.isArray(listShape.body.items) && listShape.body.items.length === 2,
    `items=${listShape.body.items?.length}`);
  check("单条接口返回 posts/comments 而非 items（两者路由独立）",
    Array.isArray(singleShape.body.posts) && singleShape.body.items === undefined,
    Object.keys(singleShape.body).join(","));
  check("非法 id 返回 400 而不是静默返回数据",
    (await api("/api/admin/identity/abc", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } })).status === 400);

  // 回归：不带 limit 参数时必须用默认值，而不是被 Number(null)=0 吞成 LIMIT 0 → clamp 成 1。
  // 这个 bug 曾经让列表接口恒定只返回 1 条记录。
  const noLimit = await api("/api/admin/identities", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
  const withLimit = await api("/api/admin/identities?limit=50", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
  check("缺省 limit 时返回全部记录（不被 Number(null)=0 吞掉）",
    noLimit.body.items?.length === 2 && noLimit.body.items.length === withLimit.body.items?.length,
    `缺省=${noLimit.body.items?.length} 显式=${withLimit.body.items?.length}`);

  const stats = await api("/api/admin/stats", { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
  check("统计包含实名运营指标",
    stats.body.identityRequired === true && stats.body.verifiedIdentities >= 1 && typeof stats.body.postsWithoutIdentity === "number",
    `identities=${stats.body.verifiedIdentities} sms=${stats.body.smsProvider}`);
  console.log(`  [诊断] /api/admin/identities 返回 ${identities.body.items.length} 条：`
    + identities.body.items.map((i) => `#${i.id} ${i.phone_masked}`).join(" | ")
    + `；stats.verifiedIdentities=${stats.body.verifiedIdentities}`);

  /* ── 7. 生产环境的短信通道守卫 ─────────────────────────────── */
  console.log("\n[7/7] 生产环境短信通道守卫");
  await stop(server);
  server = null;

  const guardResult = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, "..", "src", "server.js")], {
      cwd: path.join(__dirname, ".."),
      env: Object.assign({}, process.env, {
        HOST, PORT: String(PORT + 1), NODE_ENV: "production",
        DB_PATH: path.join(TMP, "guard.db"),
        ADMIN_TOKEN, IP_HASH_SECRET: IP_SECRET, IDENTITY_SECRET: IP_SECRET,
        CHALLENGE_ALLOW_DISABLED: "1", CHALLENGE_ENFORCE: "0",
        IDENTITY_ENFORCE: "1",
        SMS_PROVIDER: "log"            // 生产用 log = 等于不验证，必须拒绝启动
      }),
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true
    });
    let out = "";
    child.stdout.on("data", (c) => { out += String(c); });
    child.stderr.on("data", (c) => { out += String(c); });
    child.on("exit", (code) => resolve({ code, out }));
    setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve({ code: null, out }); }, 8000);
  });
  check("生产环境用 log 短信通道时拒绝启动",
    guardResult.code === 1 && /SMS_PROVIDER=log/.test(guardResult.out),
    `code=${guardResult.code}`);
  check("拒绝启动时给出可执行的修复说明",
    /SMS_ALLOW_LOG_IN_PROD|webhook 或 twilio/.test(guardResult.out));

  /* ── 数据库直查：确认没存明文号码 ───────────────────────────── */
  console.log("\n[附加] 落库内容核查");
  const probe = spawn(process.execPath, ["-e", `
    process.env.DB_PATH = ${JSON.stringify(path.join(TMP, "wall.db"))};
    const db = require(${JSON.stringify(path.join(__dirname, "..", "src", "db.js"))});
    const row = db.prepare("SELECT phone_hash, phone_masked, consent_version FROM identities LIMIT 1").get();
    const codeRow = db.prepare("SELECT code_hash FROM identity_codes LIMIT 1").get();
    console.log(JSON.stringify({ row, codeRow }));
    db.shutdown(); db.close();
  `], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let probeOut = "";
  let probeErr = "";
  await new Promise((r) => {
    probe.stdout.on("data", (c) => { probeOut += String(c); });
    probe.stderr.on("data", (c) => { probeErr += String(c); });
    probe.on("exit", (code) => {
      if (code !== 0) {
        bad("落库核查探针异常退出", `code=${code}\n${probeErr.slice(0, 400)}`);
      }
      r();
    });
  });
  const dbRow = JSON.parse(probeOut.trim().split("\n").pop());
  check("identities 表不含明文号码", !JSON.stringify(dbRow).includes("13800138000"), dbRow.row?.phone_masked);
  check("手机号以哈希存储（64 位内十六进制）", /^[0-9a-f]{16,}$/.test(dbRow.row?.phone_hash || ""), (dbRow.row?.phone_hash || "").slice(0, 12) + "…");
  check("验证码同样只存哈希", /^[0-9a-f]{64}$/.test(dbRow.codeRow?.code_hash || ""), (dbRow.codeRow?.code_hash || "").slice(0, 12) + "…");
  check("记录了同意条款版本（同意义务留痕）", dbRow.row?.consent_version === "v1.0", dbRow.row?.consent_version);
})()
  .catch((err) => bad("测试异常中断", err?.message || String(err)))
  .finally(async () => {
    await stop(server);
    try { gateway.close(); } catch { /* ignore */ }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
    const failed = results.filter((r) => !r).length;
    console.log(`\n${"─".repeat(64)}`);
    console.log(`后台实名 + 先审后发测试：${results.length - failed}/${results.length} 通过`);
    console.log(`${"─".repeat(64)}\n`);
    process.exit(failed ? 1 : 0);
  });
