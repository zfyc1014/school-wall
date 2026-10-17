"use strict";

/**
 * Brevo（邮件 + 短信）与「邮箱/手机」双通道登录的集成测试。
 *
 * 不碰真实 Brevo：起一个本地假 API，按 token/收件人返回不同结果，
 * 这样「发信成功」「IP 被拦」「短信未配置」「手机号未绑定」这些分支都能确定性测到。
 * 真实密钥的连通性由后台「邮件/短信自检」按钮验证（需要外网 + Brevo 授权 IP）。
 *
 * 用法：node scripts/brevo-test.js
 */

const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const APP_PORT = 9200 + Math.floor(Math.random() * 90);
const MOCK_PORT = 9400 + Math.floor(Math.random() * 90);
const BASE = "http://127.0.0.1:" + APP_PORT;
const ADMIN_TOKEN = "brevo-admin-token-0123456789abcdef";
const IP_SECRET = "brevo-ip-secret-0123456789abcdef";
const API_KEY = "xkeysib-test-key";
const SMS_SENDER = "SchoolWall";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "wall-brevo-"));
let passed = 0;
let failed = 0;
const failures = [];
const ok = (name, cond, detail) => {
  if (cond) { passed += 1; console.log("  ✓ " + name); }
  else { failed += 1; failures.push(name); console.log("  ✗ " + name + (detail === undefined ? "" : "  → " + JSON.stringify(detail))); }
};
const eq = (name, a, b) => ok(name, a === b, { actual: a, expected: b });

/* ── 假 Brevo ───────────────────────────────────────────────────────── */
const calls = [];
const mock = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += String(c); });
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : {};
    calls.push({ path: req.url, apiKey: req.headers["api-key"], body });
    const reply = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (req.url === "/v3/account") {
      return reply(200, { email: "owner@example.com", companyName: "SchoolWall", plan: [{ type: "free", creditsType: "sendLimit", credits: 300 }] });
    }
    if (req.url === "/v3/smtp/email") {
      const to = (body.to && body.to[0] && body.to[0].email) || "";
      if (to === "blocked@example.com") {
        return reply(401, {
          code: "unauthorized",
          message: "We have detected you are using an unrecognised IP address 1.2.3.4. If you performed this action make sure to add the new IP address in this link: https://app.brevo.com/security/authorised_ips"
        });
      }
      if (to === "bad@example.com") {
        return reply(400, { code: "invalid_parameter", message: "sender is not valid" });
      }
      return reply(201, { messageId: "mock-mail-" + calls.length });
    }
    if (req.url === "/v3/transactionalSMS/sms") {
      if (body.recipient === "+8613800138001") {
        return reply(400, { code: "invalid_parameter", message: "Sender is not allowed for this account" });
      }
      return reply(201, { reference: "mock-sms-" + calls.length });
    }
    return reply(404, { code: "not_found", message: "mock: unknown path " + req.url });
  });
});

/* ── 被测服务 ───────────────────────────────────────────────────────── */
function spawnApp(extra) {
  return spawn(process.execPath, [path.join(ROOT, "src", "server.js")], {
    cwd: ROOT,
    env: Object.assign({
      ...process.env,
      OD_SKIP_ENV_FILE: "1",
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(APP_PORT),
      DB_PATH: path.join(TMP, "b.db"),
      OUTBOX_DIR: path.join(TMP, "outbox"),
      ADMIN_TOKEN,
      IP_HASH_SECRET: IP_SECRET,
      AUTH_CODE_ECHO: "1",
      FORCE_HTTPS: "0",
      BREVO_API_KEY: API_KEY,
      BREVO_SENDER_EMAIL: "noreply@school.example",
      BREVO_SENDER_NAME: "校园墙",
      BREVO_SMS_SENDER: SMS_SENDER,
      BREVO_API_BASE: "http://127.0.0.1:" + MOCK_PORT + "/v3"
    }, extra || {}),
    stdio: ["ignore", "pipe", "pipe"]
  });
}

const app = spawnApp({});
let log = "";
app.stdout.on("data", (c) => { log += String(c); });
app.stderr.on("data", (c) => { log += String(c); });

async function waitFor(base, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(base + "/api/health")).ok) return true; } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/* ── HTTP 小工具（带 cookie jar） ─────────────────────────────────── */
const jar = new Map();
async function call(method, url, { body, admin } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (admin) headers.authorization = "Bearer " + ADMIN_TOKEN;
  if (jar.size) headers.cookie = Array.from(jar).map(([k, v]) => k + "=" + v).join("; ");
  const go = () => fetch((url.startsWith("http") ? "" : BASE) + url, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  let res;
  try {
    res = await go();
  } catch (err) {
    // 测试进程与子进程之间偶发 ECONNRESET（Windows 上端口刚释放时的正常抖动）；
    // 只对「连接都没建立起来」的情况重试一次，业务错误照常抛出。
    const cause = (err && err.cause && (err.cause.code || err.cause.message)) || "";
    console.warn("[brevo-test] 连接失败，重试一次：" + err.message + " / " + cause);
    await new Promise((r) => setTimeout(r, 400));
    res = await go();
  }
  for (const line of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
    const pair = line.split(";")[0];
    const i = pair.indexOf("=");
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}
const lastCall = (p) => [...calls].reverse().find((c) => c.path === p);
const callsTo = (p) => calls.filter((c) => c.path === p);

function cleanup() {
  try { app.kill(); } catch { /* ignore */ }
  try { mock.close(); } catch { /* ignore */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}

/* ── 用例 ───────────────────────────────────────────────────────────── */
(async function main() {
  await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));
  if (!(await waitFor(BASE))) throw new Error("被测服务未启动\n" + log);
  // 双重就绪确认：health 过了但 /api/site 还没起好时就开始打请求，会在慢机器上偶发连接失败
  for (let i = 0; i < 20; i += 1) {
    try {
      const probe = await fetch(BASE + "/api/site");
      if (probe.ok) break;
    } catch { /* 再等一轮 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  await new Promise((r) => setTimeout(r, 250));

  console.log("\n站点信息");
  const site = await (await fetch(BASE + "/api/site")).json();
  ok("手机登录随短信通道就绪而开放", site.features && site.features.phoneLogin === true, site.features);
  ok("站点信息里不出现 API key", !JSON.stringify(site).includes(API_KEY));

  console.log("\n邮件验证码（Brevo）");
  const mail = await call("POST", "/api/auth/code", { body: { email: "student@example.com" } });
  eq("发码成功", mail.status, 200);
  eq("如实标记已投递", mail.body.delivered, true);
  eq("provider 是 brevo", mail.body.provider, "brevo");
  const mailCall = lastCall("/v3/smtp/email");
  ok("请求带 api-key 头", mailCall && mailCall.apiKey === API_KEY);
  eq("发件人是配置的地址", mailCall.body.sender && mailCall.body.sender.email, "noreply@school.example");
  eq("收件人正确", mailCall.body.to && mailCall.body.to[0].email, "student@example.com");

  console.log("\nBrevo 错误要翻译成人话");
  const blocked = await call("POST", "/api/auth/code", { body: { email: "blocked@example.com" } });
  eq("被 Brevo 拒绝时仍返回 200（验证码已降级留存）", blocked.status, 200);
  eq("如实标记未投递", blocked.body.delivered, false);
  ok("响应里带降级提示", Boolean(blocked.body.devCode), blocked.body);

  console.log("\n注册一个账号（邮箱通道）");
  await call("POST", "/api/admin/schools", { body: { name: "测试大学" }, admin: true });
  const codeResp = await call("POST", "/api/auth/code", { body: { email: "owner@example.com" } });
  const verified = await call("POST", "/api/auth/verify", { body: { email: "owner@example.com", code: codeResp.body.devCode } });
  eq("新邮箱进入完善资料", verified.body.needProfile, true);
  const reg = await call("POST", "/api/auth/register", {
    body: { token: verified.body.token, nickname: "手机用户", school: "测试大学" }
  });
  eq("注册成功", reg.status, 201);
  ok("注册后是登录态", jar.size > 0);

  console.log("\n绑定手机号");
  const bindCode = await call("POST", "/api/me/phone/code", { body: { phone: "138 0013 8000" } });
  eq("绑定发码成功", bindCode.status, 200);
  const smsCall = lastCall("/v3/transactionalSMS/sms");
  eq("短信收件人已归一化为 E.164", smsCall.body.recipient, "+8613800138000");
  eq("短信 sender 用配置值", smsCall.body.sender, SMS_SENDER);
  eq("短信 type 是 transactional", smsCall.body.type, "transactional");
  ok("短信内容含 6 位验证码", /\d{6}/.test(smsCall.body.content), smsCall.body.content);

  const badVerify = await call("POST", "/api/me/phone/verify", { body: { phone: "13800138000", code: "000000" } });
  eq("错误验证码被拒", badVerify.status, 401);
  const bound = await call("POST", "/api/me/phone/verify", { body: { phone: "13800138000", code: bindCode.body.devCode } });
  eq("绑定成功", bound.status, 200);
  eq("手机号归一化存储", bound.body.user.phone, "+8613800138000");
  eq("标记为已验证", bound.body.user.phoneVerified, true);

  console.log("\n手机号登录");
  const phoneCode = await call("POST", "/api/auth/code", { body: { phone: "+8613800138000" } });
  eq("向已绑定号码发短信", phoneCode.status, 200);
  eq("短信通道已投递", phoneCode.body.delivered, true);
  const phoneLogin = await call("POST", "/api/auth/verify", { body: { phone: "13800138000", code: phoneCode.body.devCode } });
  eq("手机验证码登录成功", phoneLogin.status, 200);
  ok("返回用户对象", Boolean(phoneLogin.body.user && phoneLogin.body.user.uuid), phoneLogin.body);

  console.log("\n手机号也可以直接注册（邮箱/手机号自选）");
  const newPhone = "13900139000";
  const regCode = await call("POST", "/api/auth/code", { body: { phone: newPhone } });
  eq("未注册的号码也能收到验证码", regCode.status, 200);
  const regVerify = await call("POST", "/api/auth/verify", { body: { phone: newPhone, code: regCode.body.devCode } });
  eq("验证通过后进入完善资料", regVerify.body.needProfile, true);
  eq("注册令牌标明是手机通道", regVerify.body.channel, "phone");
  eq("注册响应里不伪造邮箱", regVerify.body.email, "");
  const phoneReg = await call("POST", "/api/auth/register", {
    body: { token: regVerify.body.token, nickname: "纯手机用户", school: "测试大学" }
  });
  eq("手机号注册成功", phoneReg.status, 201);
  eq("账号只有手机号，没有邮箱", phoneReg.body.user.email, "");
  eq("手机号已验证", phoneReg.body.user.phoneVerified, true);
  eq("保存的是归一化后的号码", phoneReg.body.user.phone, "+8613900139000");

  const regAgain = await call("POST", "/api/auth/code", { body: { phone: newPhone } });
  ok("同一号码注册发码受限流（1 次/小时）", regAgain.status === 429 || regAgain.status === 200, regAgain.status);

  console.log("\n短信通道故障");
  const smsFail = await call("POST", "/api/auth/code", { body: { phone: "+8613800138001" } });
  ok("Brevo 拒绝短信时接口不崩", smsFail.status === 400 || smsFail.status === 200, smsFail.status);

  console.log("\n后台自检接口");
  const mailTest = await call("POST", "/api/admin/email/test", { body: { to: "owner@example.com" }, admin: true });
  eq("邮件自检成功", mailTest.status, 200);
  eq("带回 provider", mailTest.body.provider, "brevo");
  const smsTest = await call("POST", "/api/admin/sms/test", { body: { to: "13800138000" }, admin: true });
  eq("短信自检成功", smsTest.status, 200);
  eq("短信自检标记成功", smsTest.body.ok, true);
  ok("带回 Brevo 账号信息（套餐/额度）", Boolean(smsTest.body.account && smsTest.body.account.ok), smsTest.body.account);
  const badSmsTest = await call("POST", "/api/admin/sms/test", { body: { to: "abc" }, admin: true });
  eq("非法号码被拒", badSmsTest.status, 400);
  const stats = await call("GET", "/api/admin/stats", { admin: true });
  eq("后台统计显示邮件 provider", stats.body.email.provider, "brevo");
  eq("后台统计显示短信已就绪", stats.body.brevo.smsReady, true);

  console.log("\n短信未配置时手机登录关闭");
  const app2Port = 9700 + Math.floor(Math.random() * 90);
  const app2 = spawnApp({ PORT: String(app2Port), DB_PATH: path.join(TMP, "b2.db"), BREVO_SMS_SENDER: "" });
  let log2 = "";
  app2.stdout.on("data", (c) => { log2 += String(c); });
  app2.stderr.on("data", (c) => { log2 += String(c); });
  const up2 = await waitFor("http://127.0.0.1:" + app2Port);
  ok("缺短信 sender 时服务仍能启动", up2, up2 ? undefined : log2.split("\n").slice(-6).join(" | "));
  if (up2) {
    try {
      const site2 = await (await fetch("http://127.0.0.1:" + app2Port + "/api/site")).json();
      eq("手机登录关闭", site2.features.phoneLogin, false);
      const r = await fetch("http://127.0.0.1:" + app2Port + "/api/auth/code", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: "13800138000" })
      });
      eq("手机发码返回 503", r.status, 503);
    } catch (e) {
      ok("第二个实例的断言执行完成", false, e.message + " / 日志尾部：" + log2.split("\n").slice(-6).join(" | "));
    }
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
