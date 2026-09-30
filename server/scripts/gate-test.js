"use strict";

/**
 * 内测门禁 · 接口测试（自托管：邀请码 + 一次性本地挑战 + 短期会话 cookie）
 *
 * 为什么要单独一个脚本：门禁的行为**完全由环境变量决定**（开关、邀请码、
 * 会话时长、题目数、答错上限），因此这里按「档」分批启动真实服务进程，
 * 每档只验证那一组配置下的可观察行为，互不干扰。
 *
 * 覆盖：
 *   1. 门禁关闭档：配置报告未启用、不出题、写接口直接放行
 *   2. 门禁开启档：配置字段、题数与题面不泄答案、邀请码校验（空/错/多码）、
 *      答对换会话、会话复用（不必反复答题）、挑战一次性
 *   3. 会话档：挑战绑定 IP、会话按期失效（手工签发对比）、登出清 cookie
 *   4. 答错上限档：剩余次数递减 → 超限作废 → 即便答案正确也不再受理
 *   5. 先审后发链路：过门禁 → 待审 → 审核通过才公开/计数，含审核队列与统计
 *   6. 反馈链路：需过门禁、后台队列可读、resolve 后出队、正文长度校验
 *   7. 生产守卫档：无邀请码拒绝启动；显式 GATE_ALLOW_DISABLED=1 时能起来
 *   8. 限流档：/api/gate/verify 20 次/10 分钟后 429（放最后，避免污染其它检查）
 *
 * 用法：node scripts/gate-test.js
 * 全部使用临时数据库与临时端口，不会碰 data/wall.db。
 */

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const PORT = 8400 + Math.floor(Math.random() * 200);
const HOST = "127.0.0.1";
const BASE = "http://" + HOST + ":";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "od-gate-test-"));
const ADMIN_TOKEN = crypto.randomBytes(24).toString("hex");
const IP_SECRET = crypto.randomBytes(16).toString("hex");
const GATE_SECRET = crypto.randomBytes(16).toString("hex");

/** 多邀请码：用于验证「多个码都可用」（每个至少 8 位，见 gate.js 的 MIN_CODE_LEN） */
const CODES = ["GATE-TEST-CODE-1", "GATE-TEST-CODE-2"];
const ADMIN = { authorization: `Bearer ${ADMIN_TOKEN}` };

const results = [];
const ok = (name, detail = "") => { results.push(true); console.log(`  \u2713 ${name}${detail ? `  — ${detail}` : ""}`); };
const bad = (name, detail = "") => { results.push(false); console.log(`  \u2717 ${name}${detail ? `  — ${detail}` : ""}`); };
const check = (name, cond, detail = "") => { if (cond) ok(name, detail); else bad(name, detail); return Boolean(cond); };

/** 公共环境：各档只覆盖自己关心的那几个变量 */
const env = {
  ...process.env,
  HOST,
  NODE_ENV: "development", // 生产语义单独放在守卫档里验证
  DB_PATH: path.join(TMP, "wall.db"),
  ADMIN_TOKEN,
  IP_HASH_SECRET: IP_SECRET,
  WEB_ROOT: path.resolve(__dirname, "..", ".."), // 与 server.js 的默认一致（仓库根）
  INDEX_FILE: "index.html",
  LIKE_FLUSH_MS: "60",
  FEED_CACHE_MS: "0", // 关掉短时缓存，避免掩盖审核后的数据变化
  ADMIN_RATE_LIMIT: "1000", // 测试会高频调管理接口，放宽鉴权限流
  DB_CHECKPOINT_MS: "600000",
  DB_CLEANUP_MS: "600000",
  RETENTION_DAYS: "0",
  // 门禁默认档：开启 + 两个邀请码 + 允许明文 HTTP 下回传 cookie
  GATE_ENFORCE: "1",
  GATE_INVITE_CODES: CODES.join(","),
  GATE_COOKIE_SECURE: "0",
  GATE_TTL: "120",
  GATE_CHALLENGE_ITEMS: "3"
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
  // 等进程真的退出：紧接着要起下一档，端口没释放会 EADDRINUSE
  const exited = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
  try { child.kill("SIGKILL"); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 150));
}

/** 启动日志分多行下发，就绪判定只看第一行，其余信息要等一下才到 */
async function waitForLog(handle, pattern, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(handle.log())) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pattern.test(handle.log());
}

let currentPort = PORT;

async function api(pathname, options = {}) {
  const init = Object.assign({ headers: {} }, options);
  const base = BASE + currentPort;
  let res = null;
  let lastErr = null;

  // 一次重试：本脚本会在中途重启被测服务，而 Node 的 fetch（undici）会保留
  // keep-alive 连接池，旧连接可能指向刚被替换掉的进程。这类失败是测试脚手架的
  // 问题，不是服务的问题，重试一次即可；同时把 socket 层错误码打出来便于判断。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if (init.method && init.method !== "GET") {
        process.stderr.write(`      → ${init.method} ${pathname}\n`);
      }
      res = await fetch(base + pathname, init);
      if (init.method && init.method !== "GET") process.stderr.write(`      ← ${res.status}\n`);
      break;
    } catch (err) {
      lastErr = err;
      const code = err?.cause?.code || err?.code || "";
      if (!serverAlive()) {
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

/** 带 JSON 请求体的 POST（门禁测试里绝大多数写请求都是这个形状） */
const jsonPost = (pathname, payload, extraHeaders = {}) => api(pathname, {
  method: "POST",
  headers: Object.assign({ "content-type": "application/json" }, extraHeaders),
  body: JSON.stringify(payload)
});

/** 指定客户端 IP 的请求（仅在 TRUST_PROXY=1 的那一档里有意义） */
const asIp = (ip) => (pathname, options = {}) => api(pathname, Object.assign({}, options, {
  headers: Object.assign({}, options.headers || {}, { "x-forwarded-for": ip })
}));
const jsonPostAs = (asIpFn) => (pathname, payload, extraHeaders = {}) => asIpFn(pathname, {
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

(async () => {
  console.log(`\n内测门禁接口测试：${BASE}${PORT}（临时库 ${env.DB_PATH}）\n`);

  /* ── 1. 门禁关闭档 ─────────────────────────────────────────── */
  console.log("[1/8] 门禁关闭档（开发环境、未配置邀请码）");
  currentPort = PORT + 1;
  server = (await startServer({ PORT: String(currentPort), GATE_ENFORCE: "0", GATE_INVITE_CODES: "" })).child;

  const cfg1 = await api("/api/gate/config");
  check("门禁关闭时配置报告 enabled/required 均为 false",
    cfg1.status === 200 && cfg1.body.enabled === false && cfg1.body.required === false,
    JSON.stringify(cfg1.body).slice(0, 110) + "…");
  check("门禁关闭时配置不下发任何第三方挑战密钥",
    !/siteKey|site_key|turnstile|recaptcha|hcaptcha/i.test(JSON.stringify(cfg1.body)));

  const ch1 = await api("/api/gate/challenge", { method: "POST" });
  check("门禁关闭时出题接口直接返回 {enabled:false}",
    ch1.status === 200 && ch1.body.enabled === false && ch1.body.id === undefined,
    JSON.stringify(ch1.body));

  const w1 = await jsonPost("/api/posts", { cat: "表白", body: "门禁关闭时这条内容应当直接进入待审队列。" });
  check("门禁关闭时写接口直接放行（返回 pending）",
    w1.status === 201 && w1.body.status === "pending", JSON.stringify(w1.body));

  await stopServer(server);
  server = null;

  /* ── 2. 门禁开启档 ─────────────────────────────────────────── */
  console.log("\n[2/8] 门禁开启档（邀请码 + 一次性挑战 + 会话 cookie）");
  currentPort = PORT + 2;
  server = (await startServer({ PORT: String(currentPort) })).child;

  const cfg2 = await api("/api/gate/config");
  check("配置报告需要门禁且已配置邀请码",
    cfg2.body.enabled === true && cfg2.body.required === true && cfg2.body.inviteRequired === true,
    JSON.stringify(cfg2.body).slice(0, 110) + "…");
  check("会话时长按 GATE_TTL=120 下发", cfg2.body.sessionTtl === 120, `sessionTtl=${cfg2.body.sessionTtl}`);
  check("题目数按 GATE_CHALLENGE_ITEMS=3 下发", cfg2.body.challengeItems === 3, `challengeItems=${cfg2.body.challengeItems}`);

  const ch = await fetchChallenge();
  check("出题数量与声明一致", ch.challengeRes.status === 200 && ch.items.length === 3, `${ch.items.length} 题`);
  check("题面只有题目、不含答案字段",
    ch.items.every((it) => Object.keys(it).length === 1 && typeof it.q === "string"
      && it.a === undefined && it.answer === undefined),
    JSON.stringify(ch.items));

  const emptyCode = await jsonPost("/api/gate/verify", { code: "", challengeId: ch.challengeId, answers: ch.answers });
  check("空邀请码被拒（403 invalid_code）",
    emptyCode.status === 403 && emptyCode.body.error === "invalid_code", JSON.stringify(emptyCode.body));
  const wrongCode = await jsonPost("/api/gate/verify", { code: "GATE-TEST-NOPE", challengeId: ch.challengeId, answers: ch.answers });
  check("错误邀请码被拒（403 invalid_code）",
    wrongCode.status === 403 && wrongCode.body.error === "invalid_code", JSON.stringify(wrongCode.body));

  // 同一个挑战 + 第二个邀请码：既验证多码可用，也说明前面两次失败只因邀请码不对
  const verified = await jsonPost("/api/gate/verify", {
    code: CODES[1], challengeId: ch.challengeId, answers: ch.answers
  });
  const setCookie = verified.headers.get("set-cookie") || "";
  check("多个邀请码中的第二个同样可以通过",
    verified.status === 200 && verified.body.verified === true, JSON.stringify(verified.body));
  check("会话 cookie 形如 <过期时间>.<base64url 签名>",
    /^od_gate=\d+\.[A-Za-z0-9_-]+$/.test(setCookie.split(";")[0]), setCookie.split(";")[0].slice(0, 36) + "…");
  check("会话 cookie 为 HttpOnly + SameSite=Lax + Path=/",
    /HttpOnly/i.test(setCookie) && /SameSite=Lax/i.test(setCookie) && /Path=\//.test(setCookie),
    setCookie);
  const cookie = setCookie.split(";")[0];

  const write1 = await jsonPost("/api/posts", { cat: "树洞", body: "过门禁后的第一条内容。" }, { cookie });
  check("过门禁后写请求放行（201 pending）",
    write1.status === 201 && write1.body.status === "pending", JSON.stringify(write1.body));
  const write2 = await jsonPost("/api/posts", { cat: "寻人", body: "过门禁后的第二条内容，不应再要求答题。" }, { cookie });
  check("会话有效期内第二次写请求仍放行（会话被复用，不必重新答题）",
    write2.status === 201 && write2.body.status === "pending", JSON.stringify(write2.body));

  // 答错 → 剩余次数（默认上限 5）
  const ch3 = await fetchChallenge();
  const wrongAns = await jsonPost("/api/gate/verify", { code: CODES[0], challengeId: ch3.challengeId, answers: ["-1"] });
  check("答错一次返回剩余次数（remaining=4）",
    wrongAns.status === 403 && wrongAns.body.error === "challenge_failed" && wrongAns.body.remaining === 4,
    JSON.stringify(wrongAns.body));

  // 一次性：答对后服务端立刻作废该挑战，不给重放留窗口
  const replay = await jsonPost("/api/gate/verify", { code: CODES[1], challengeId: ch.challengeId, answers: ch.answers });
  check("挑战一次性：答对后再用同一 id 提交返回 409",
    replay.status === 409 && replay.body.error === "challenge_expired", JSON.stringify(replay.body));

  await stopServer(server);
  server = null;

  /* ── 3. 会话档（挑战绑定 IP / 会话有效期 / 登出）────────────── */
  console.log("\n[3/8] 会话档（TRUST_PROXY=1：客户端 IP 由 X-Forwarded-For 决定）");
  currentPort = PORT + 3;
  server = (await startServer({
    PORT: String(currentPort),
    TRUST_PROXY: "1",
    GATE_SECRET // 固定签名密钥，才能自己算出「签名正确但已过期」的会话
  })).child;

  const postFromA = jsonPostAs(asIp("10.1.1.1"));
  const postFromB = jsonPostAs(asIp("10.1.1.2"));
  const postFromC = jsonPostAs(asIp("10.1.1.3"));

  // 挑战与 IP 绑定：同一份题从另一个 IP 提交必然失败
  const chA = await asIp("10.1.1.1")("/api/gate/challenge", { method: "POST" });
  const chA2 = await asIp("10.1.1.1")("/api/gate/challenge", { method: "POST" });
  const crossIp = await postFromB("/api/gate/verify", {
    code: CODES[0], challengeId: chA.body.id, answers: solveAll(chA.body.items)
  });
  check("换一个 IP 提交同一挑战被拒（挑战与 IP 绑定）",
    crossIp.status === 409 && crossIp.body.error === "challenge_expired", JSON.stringify(crossIp.body));
  const sameIp = await postFromA("/api/gate/verify", {
    code: CODES[0], challengeId: chA2.body.id, answers: solveAll(chA2.body.items)
  });
  check("同一 IP 的另一份挑战正常换取会话（对照组）",
    sameIp.status === 200 && sameIp.body.verified === true, JSON.stringify(sameIp.body));

  /**
   * 会话过期怎么测才可靠：
   *   gate.js 把 GATE_TTL 夹在 [60, 30 天]，设成 1 会被抬到 60 秒，等不起；
   *   所以这里用已知的 IP_HASH_SECRET 与 GATE_SECRET 自己签一份**签名正确但已过期**
   *   的会话，再签一份**未过期**的作为对照组 —— 两者只差过期时间，
   *   否则「被拒」到底是过期导致还是签名不对导致就说不清了。
   */
  const ipHashOf = (ip) => crypto.createHmac("sha256", IP_SECRET).update(String(ip)).digest("hex").slice(0, 24);
  const signSession = (ip, exp, key = GATE_SECRET) => {
    const mac = crypto.createHmac("sha256", key).update(`${ipHashOf(ip)}.${exp}`).digest("base64url");
    return `od_gate=${exp}.${mac}`;
  };
  const staleCookie = signSession("10.1.1.3", Date.now() - 60_000);
  const freshCookie = signSession("10.1.1.3", Date.now() + 60_000);
  const foreignCookie = signSession("10.1.1.3", Date.now() + 60_000, crypto.randomBytes(16).toString("hex"));

  const staleWrite = await postFromC("/api/posts", { cat: "表白", body: "已过期的会话不应该放行。" }, { cookie: staleCookie });
  check("已过期（签名正确）的会话被 403 拦下",
    staleWrite.status === 403 && staleWrite.body.error === "gate_required", JSON.stringify(staleWrite.body));
  const freshWrite = await postFromC("/api/posts", { cat: "树洞", body: "未过期的会话应当放行（对照组）。" }, { cookie: freshCookie });
  check("未过期的会话被放行（对照组，证明上一条是过期导致）",
    freshWrite.status === 201 && freshWrite.body.status === "pending", JSON.stringify(freshWrite.body));
  const foreignWrite = await postFromC("/api/posts", { cat: "寻人", body: "换密钥签出的会话不应该放行。" }, { cookie: foreignCookie });
  check("用其它密钥签出的会话被 403 拦下",
    foreignWrite.status === 403 && foreignWrite.body.error === "gate_required", JSON.stringify(foreignWrite.body));

  const logout = await asIp("10.1.1.3")("/api/gate/logout", { method: "POST" });
  const cleared = logout.headers.get("set-cookie") || "";
  check("登出返回未验证并要求清除 cookie（Max-Age=0）",
    logout.status === 200 && logout.body.verified === false && /Max-Age=0/.test(cleared),
    `${JSON.stringify(logout.body)} · ${cleared}`);

  await stopServer(server);
  server = null;

  /* ── 4. 答错上限档 ─────────────────────────────────────────── */
  console.log("\n[4/8] 答错上限档（GATE_MAX_ATTEMPTS=2）");
  currentPort = PORT + 4;
  server = (await startServer({ PORT: String(currentPort), GATE_MAX_ATTEMPTS: "2" })).child;

  const ch4 = await fetchChallenge();
  const wrong1 = await jsonPost("/api/gate/verify", { code: CODES[0], challengeId: ch4.challengeId, answers: ["-1"] });
  check("第 1 次答错：还剩 1 次机会",
    wrong1.status === 403 && wrong1.body.error === "challenge_failed" && wrong1.body.remaining === 1,
    JSON.stringify(wrong1.body));
  const wrong2 = await jsonPost("/api/gate/verify", { code: CODES[0], challengeId: ch4.challengeId, answers: ["-1"] });
  check("第 2 次答错：剩余次数归零",
    wrong2.status === 403 && wrong2.body.error === "challenge_failed" && wrong2.body.remaining === 0,
    JSON.stringify(wrong2.body));
  const third = await jsonPost("/api/gate/verify", { code: CODES[0], challengeId: ch4.challengeId, answers: ch4.answers });
  check("第 3 次提交（答案完全正确）仍被拒：挑战已作废",
    third.status === 403 && third.body.error === "challenge_failed" && /错误次数过多/.test(third.body.message || ""),
    JSON.stringify(third.body));
  const fourth = await jsonPost("/api/gate/verify", { code: CODES[0], challengeId: ch4.challengeId, answers: ch4.answers });
  check("作废后再提交返回 409 challenge_expired",
    fourth.status === 409 && fourth.body.error === "challenge_expired", JSON.stringify(fourth.body));

  const recovered = await openGateSession(CODES[0]);
  check("重新取题后仍可正常通过（作废只影响那一份挑战）",
    recovered.res.status === 200 && recovered.res.body.verified === true, JSON.stringify(recovered.res.body));

  await stopServer(server);
  server = null;

  /* ── 5. 先审后发链路（原来的「先实名」换成「先过门禁」）────── */
  console.log("\n[5/8] 先审后发链路（帖子与评论）");
  currentPort = PORT + 5;
  server = (await startServer({ PORT: String(currentPort) })).child;

  const session5 = await openGateSession(CODES[0]);
  const cookie5 = session5.cookie;

  const created = await jsonPost("/api/posts", { cat: "表白", body: "过了门禁之后发布的内容，应当进入待审队列。" }, { cookie: cookie5 });
  check("过门禁后可以发布（201 pending）",
    created.status === 201 && created.body.status === "pending", JSON.stringify(created.body));
  const postId = created.body.id;

  const queuePosts = await api("/api/admin/queue?type=posts", { headers: ADMIN });
  check("审核队列接口能取到待审帖子",
    queuePosts.status === 200 && Array.isArray(queuePosts.body.items)
      && queuePosts.body.items.some((i) => String(i.id) === String(postId)),
    `队列 ${queuePosts.body.items?.length} 条`);

  const feedBefore = await api("/api/posts?sort=new&limit=50");
  check("待审内容不出现在公开列表",
    !feedBefore.body.items.some((i) => String(i.id) === String(postId)));

  const approve = await api(`/api/admin/posts/${postId}/approve`, { method: "POST", headers: ADMIN });
  check("审核通过成功（回显审核前后状态）",
    approve.status === 200 && approve.body.status === "approved" && approve.body.from === "pending",
    JSON.stringify(approve.body));

  // 审核留痕：内测版把「谁在什么时候把什么从什么状态改成了什么」记在 audit_log，
  // 并可通过 /api/admin/audit 读回（原来的 review_note 列已随重构移除）。
  const auditTrail = await api("/api/admin/audit?action=post.approve", { headers: ADMIN });
  check("审核留痕可从 /api/admin/audit 读回（target=帖子 id）",
    auditTrail.status === 200
      && auditTrail.body.items.some((i) => String(i.target) === String(postId) && i.action === "post.approve"),
    `${auditTrail.body.items?.length} 条 post.approve`);

  const feedAfter = await api("/api/posts?sort=new&limit=50");
  check("审核通过后出现在公开列表",
    feedAfter.body.items.some((i) => String(i.id) === String(postId)));

  const comment = await jsonPost(`/api/posts/${postId}/comments`, { body: "这是一条评论，同样应该先审后发。" }, { cookie: cookie5 });
  check("评论提交后为 pending（不再默认公开）",
    comment.status === 201 && comment.body.status === "pending", JSON.stringify(comment.body));
  const commentId = comment.body.id;

  const commentsBefore = await api(`/api/posts/${postId}/comments`);
  check("待审评论不出现在公开评论区", commentsBefore.body.items.length === 0, `${commentsBefore.body.items.length} 条`);

  const queueComments = await api("/api/admin/queue?type=comments", { headers: ADMIN });
  check("审核队列能取到待审评论",
    queueComments.body.items.some((i) => String(i.id) === String(commentId)), `队列 ${queueComments.body.items?.length} 条`);

  const commentApprove = await api(`/api/admin/comments/${commentId}/approve`, { method: "POST", headers: ADMIN });
  check("评论审核通过时计数 +1",
    commentApprove.status === 200 && commentApprove.body.status === "approved" && commentApprove.body.commentCountDelta === 1,
    JSON.stringify(commentApprove.body));

  const commentsAfter = await api(`/api/posts/${postId}/comments`);
  check("评论审核通过后才出现在公开评论区",
    commentsAfter.body.items.length === 1 && String(commentsAfter.body.items[0].id) === String(commentId),
    `${commentsAfter.body.items.length} 条`);

  const rowApproved = (await api("/api/posts?sort=new&limit=50")).body.items.find((i) => String(i.id) === String(postId));
  check("评论计数在审核通过时才 +1", rowApproved && rowApproved.comments === 1, `comments=${rowApproved?.comments}`);

  const commentReject = await api(`/api/admin/comments/${commentId}/reject`, { method: "POST", headers: ADMIN });
  const rowRejected = (await api("/api/posts?sort=new&limit=50")).body.items.find((i) => String(i.id) === String(postId));
  const commentRejectAgain = await api(`/api/admin/comments/${commentId}/reject`, { method: "POST", headers: ADMIN });
  check("驳回已通过评论后计数 -1，重复驳回不再继续下漂",
    commentReject.body.commentCountDelta === -1 && rowRejected.comments === 0
      && commentRejectAgain.body.commentCountDelta === 0,
    `delta=${commentReject.body.commentCountDelta} comments=${rowRejected?.comments} 再驳回 delta=${commentRejectAgain.body.commentCountDelta}`);

  const stats5 = await api("/api/admin/stats", { headers: ADMIN });
  check("管理统计包含门禁与内测指标",
    stats5.status === 200 && stats5.body.gateRequired === true && stats5.body.gateInviteRequired === true
      && stats5.body.betaVersion === "0.9.0-beta.1" && typeof stats5.body.openFeedback === "number"
      && stats5.body.db && stats5.body.db.fileBytes > 0 && typeof stats5.body.db.counts.feedback === "number",
    `gate=${stats5.body.gateRequired} invite=${stats5.body.gateInviteRequired} beta=${stats5.body.betaVersion} openFeedback=${stats5.body.openFeedback} db=${Math.round((stats5.body.db?.fileBytes || 0) / 1024)}KB`);

  const unauth = await api("/api/admin/queue");
  check("未鉴权的管理接口返回 401", unauth.status === 401, `status=${unauth.status}`);

  /* ── 6. 反馈链路 ───────────────────────────────────────────── */
  console.log("\n[6/8] 内测反馈链路");
  const fbNoGate = await jsonPost("/api/feedback", { body: "没有过门禁的反馈不应该入库。" });
  check("反馈需要先过门禁（403 gate_required）",
    fbNoGate.status === 403 && fbNoGate.body.error === "gate_required", JSON.stringify(fbNoGate.body));

  const fbShort = await jsonPost("/api/feedback", { body: "短" }, { cookie: cookie5 });
  check("反馈正文过短返回 400", fbShort.status === 400, `status=${fbShort.status}`);
  const fbLong = await jsonPost("/api/feedback", { body: "长".repeat(900) }, { cookie: cookie5 });
  check("反馈正文超长返回 400", fbLong.status === 400, `status=${fbLong.status}`);

  const fbOk = await jsonPost("/api/feedback", { body: "内测反馈：希望增加夜间模式。", cat: "idea" }, { cookie: cookie5 });
  check("反馈提交成功并返回 id",
    fbOk.status === 201 && fbOk.body.ok === true && Number(fbOk.body.id) > 0, JSON.stringify(fbOk.body));
  const feedbackId = fbOk.body.id;

  const openQueue = await api("/api/admin/feedback?status=open", { headers: ADMIN });
  check("后台反馈队列能读到待处理反馈",
    openQueue.status === 200 && openQueue.body.items.some((i) => String(i.id) === String(feedbackId) && i.status === "open"),
    `待处理 ${openQueue.body.items?.length} 条`);

  const resolve = await jsonPost(`/api/admin/feedback/${feedbackId}/resolve`, { action: "done" }, ADMIN);
  check("反馈可标记为已处理（done）",
    resolve.status === 200 && resolve.body.status === "done", JSON.stringify(resolve.body));

  const openAfter = await api("/api/admin/feedback?status=open", { headers: ADMIN });
  const doneQueue = await api("/api/admin/feedback?status=done", { headers: ADMIN });
  check("已处理反馈从待处理队列消失并进入 done",
    !openAfter.body.items.some((i) => String(i.id) === String(feedbackId))
      && doneQueue.body.items.some((i) => String(i.id) === String(feedbackId) && i.status === "done"),
    `open=${openAfter.body.items?.length} done=${doneQueue.body.items?.length}`);

  await stopServer(server);
  server = null;

  /* ── 7. 生产守卫档 ─────────────────────────────────────────── */
  console.log("\n[7/8] 生产环境启动守卫");
  const guard = await startExpectExit({
    NODE_ENV: "production",
    PORT: String(PORT + 6),
    GATE_ENFORCE: "",
    GATE_INVITE_CODES: "",
    GATE_ALLOW_DISABLED: "" // 明确不设逃生开关
  });
  check("生产环境未配置邀请码时拒绝启动（退出码 1）",
    guard.code === 1, `code=${guard.code} signal=${guard.signal}`);
  check("拒绝启动时点明原因并给出可执行的修复说明",
    /GATE_INVITE_CODES/.test(guard.out)
      && /修复：设置 GATE_INVITE_CODES=/.test(guard.out)
      && /GATE_ALLOW_DISABLED/.test(guard.out),
    (guard.out.match(/\[fatal\][^\n]*/) || [""])[0]);

  currentPort = PORT + 7;
  const relaxed = await startServer({
    NODE_ENV: "production",
    PORT: String(currentPort),
    GATE_ENFORCE: "",
    GATE_INVITE_CODES: "",
    GATE_ALLOW_DISABLED: "1"
  });
  server = relaxed.child;
  await waitForLog(relaxed, /内测门禁 关闭/);
  check("显式设置 GATE_ALLOW_DISABLED=1 后能正常启动（日志报告门禁关闭）",
    /内测门禁 关闭/.test(relaxed.log()),
    (relaxed.log().match(/\[up\] 内测门禁[^\n]*/) || [""])[0]);

  await stopServer(server);
  server = null;

  /* ── 8. 限流档（放最后：会把该 IP 的校验额度打满）──────────── */
  console.log("\n[8/8] 限流档（/api/gate/verify 20 次 / 10 分钟）");
  currentPort = PORT + 8;
  server = (await startServer({ PORT: String(currentPort) })).child;

  let denied = 0;
  let limited = null;
  for (let i = 1; i <= 21; i += 1) {
    const r = await jsonPost("/api/gate/verify", { code: "GATE-TEST-NOPE", challengeId: "x", answers: [] });
    if (r.status === 403 && r.body.error === "invalid_code") denied += 1;
    if (r.status === 429) { limited = r; break; }
  }
  check("限流窗口内前 20 次校验正常返回 invalid_code", denied === 20, `放行 ${denied} 次`);
  check("第 21 次校验被 429 限流（带 retryAfter）",
    limited !== null && limited.body.error === "rate_limited" && limited.body.retryAfter > 0,
    JSON.stringify(limited && limited.body));
})()
  .catch((err) => bad("门禁测试异常中断", err?.message || String(err)))
  .finally(async () => {
    await stopServer(server);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
    const failed = results.filter((r) => !r).length;
    console.log(`\n${"─".repeat(64)}`);
    console.log(`内测门禁测试：${results.length - failed}/${results.length} 通过`);
    if (failed) {
      console.log("失败项需要在合并前修掉。");
    }
    console.log(`${"─".repeat(64)}\n`);
    process.exit(failed ? 1 : 0);
  });
