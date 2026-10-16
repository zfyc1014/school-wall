"use strict";

/**
 * 爱发电（赞助）接入测试。
 *
 * 关键点：**签名在测试里独立实现一遍**（照官方文档的算法自己拼串），
 * 而不是调用被测代码的 sign() —— 否则就是「用自己证明自己」，
 * 算法写错了也测不出来。
 *
 * 覆盖：签名校验、伪造签名被拒、下单留言匹配 uuid / 邮箱、发奖（头衔）、
 * 平台重试的幂等性、未支付订单不发奖、后台手动绑定与统计。
 *
 * 用法：node scripts/afdian-test.js
 */

const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PORT = 8700 + Math.floor(Math.random() * 150);
const BASE = "http://127.0.0.1:" + PORT;
const ADMIN_TOKEN = "afdian-admin-token-0123456789abcdef";
const IP_SECRET = "afdian-ip-hash-secret-0123456789abcdef";
const AFDIAN_TOKEN = "afdian-test-token-abcdef";
const AFDIAN_USER_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "wall-afdian-"));
const DB_PATH = path.join(TMP, "afdian.db");

let passed = 0;
let failed = 0;
const failures = [];
const ok = (name, cond, detail) => {
  if (cond) { passed += 1; console.log("  ✓ " + name); }
  else { failed += 1; failures.push(name); console.log("  ✗ " + name + (detail === undefined ? "" : "  → " + JSON.stringify(detail))); }
};
const eq = (name, a, b) => ok(name, a === b, { actual: a, expected: b });

/* ── 独立实现的签名（照文档算法，与实现无共享代码）──────────────────── */

function docSign({ token, params, ts, userId }) {
  return crypto.createHash("md5")
    .update(token + "params" + params + "ts" + ts + "user_id" + userId, "utf8")
    .digest("hex");
}

/** 构造爱发电风格的回调表单：params=<外层JSON>&sign=<md5> */
function buildCallback(event, { ts = Math.floor(Date.now() / 1000), token = AFDIAN_TOKEN, breakSign = false } = {}) {
  const inner = JSON.stringify(event);
  const sign = docSign({ token, params: inner, ts, userId: AFDIAN_USER_ID });
  const envelope = JSON.stringify({
    user_id: AFDIAN_USER_ID,
    params: inner,
    ts,
    sign: breakSign ? "0".repeat(32) : sign
  });
  return "params=" + encodeURIComponent(envelope) + "&sign=" + encodeURIComponent(breakSign ? "0".repeat(32) : sign);
}

function orderPayload(overrides = {}) {
  return {
    type: "order",
    order: Object.assign({
      out_trade_no: "2026" + Math.floor(Math.random() * 1e9),
      user_id: AFDIAN_USER_ID,
      plan_id: "plan-1",
      month: 1,
      total_amount: "5.00",
      show_amount: "5.00",
      status: 2,
      remark: "",
      created_at: Math.floor(Date.now() / 1000)
    }, overrides)
  };
}

/* ── 服务进程 ─────────────────────────────────────────────────────────── */

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
    FORCE_HTTPS: "0",
    AFDIAN_USER_ID,
    AFDIAN_TOKEN,
    AFDIAN_PAGE: "https://afdian.com/a/school-wall",
    AFDIAN_REWARD_TIERS: "5:股东;10:@custom"
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
    try { if ((await fetch(BASE + "/api/health")).ok) return; } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("服务未启动\n" + serverLog);
}

const jar = new Map();
async function call(method, url, { body, form, admin } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (form !== undefined) headers["content-type"] = "application/x-www-form-urlencoded";
  if (admin) headers.authorization = "Bearer " + ADMIN_TOKEN;
  if (jar.size) headers.cookie = Array.from(jar).map(([k, v]) => k + "=" + v).join("; ");
  const res = await fetch(BASE + url, {
    method, headers, body: form !== undefined ? form : (body === undefined ? undefined : JSON.stringify(body))
  });
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

(async function main() {
  await waitForServer();

  console.log("配置与站点信息");
  await call("POST", "/api/admin/schools", { body: { name: "赞助大学" }, admin: true });
  const code = await call("POST", "/api/auth/code", { body: { email: "sponsor@example.com" } });
  const verified = await call("POST", "/api/auth/verify", { body: { email: "sponsor@example.com", code: code.body.devCode } });
  const reg = await call("POST", "/api/auth/register", {
    body: { token: verified.body.token, nickname: "热心同学", school: "赞助大学" }
  });
  eq("注册测试用户", reg.status, 201);
  const uuid = reg.body.user.uuid;
  const email = "sponsor@example.com";

  const site = await call("GET", "/api/site");
  eq("站点信息带出爱发电主页（前端据此显示入口）", site.body.afdian && site.body.afdian.page, "https://afdian.com/a/school-wall");

  console.log("\n回调：签名与幂等");
  const bad = await call("POST", "/api/afdian/webhook", { form: buildCallback(orderPayload({ remark: uuid }), { breakSign: true }) });
  eq("伪造签名被拒（ec=403）", bad.body.ec, 403);
  const afterBad = await call("GET", "/api/admin/afdian", { admin: true });
  eq("被拒的回调不落库", afterBad.body.stats.total, 0);
  eq("被拒原因记录在案（便于排查）", afterBad.body.recentWebhooks[0].reason, "bad_sign");

  const order1 = orderPayload({ remark: "我的 uuid 是 " + uuid, out_trade_no: "ORDER-1001" });
  const first = await call("POST", "/api/afdian/webhook", { form: buildCallback(order1) });
  eq("合法回调返回 ec=200（平台据此停止重试）", first.body.ec, 200);
  eq("em 为空串（照官方约定）", first.body.em, "");

  const list1 = await call("GET", "/api/admin/afdian", { admin: true });
  eq("订单已入库", list1.body.stats.total, 1);
  eq("留言里的 uuid 匹配到了本站用户", list1.body.items[0].user && list1.body.items[0].user.uuid, uuid);
  eq("匹配方式记录为 remark_uuid", list1.body.items[0].matchedBy, "remark_uuid");
  ok("发放内容已记录", String(list1.body.items[0].reward).includes("头衔"), list1.body.items[0].reward);

  const me = await call("GET", "/api/auth/me");
  eq("发电 5 元自动拿到固定头衔「股东」", me.body.user.title && me.body.user.title.name, "股东");

  const second = await call("POST", "/api/afdian/webhook", { form: buildCallback(order1) });
  eq("平台重试仍然返回 ec=200", second.body.ec, 200);
  const list2 = await call("GET", "/api/admin/afdian", { admin: true });
  eq("重试不会产生第二条订单（out_trade_no 唯一）", list2.body.stats.total, 1);
  eq("重试不会重复发奖", list2.body.stats.paid, 1);

  console.log("\n回调：邮箱匹配 / 未匹配 / 未支付");
  const emailOrder = orderPayload({ remark: "赞助一下，" + email, out_trade_no: "ORDER-1002" });
  await call("POST", "/api/afdian/webhook", { form: buildCallback(emailOrder) });
  const list3 = await call("GET", "/api/admin/afdian", { admin: true });
  const byEmail = list3.body.items.find((o) => o.outTradeNo === "ORDER-1002");
  eq("留言里的邮箱也能匹配", byEmail.matchedBy, "remark_email");

  const noRemark = orderPayload({ remark: "", out_trade_no: "ORDER-1003" });
  await call("POST", "/api/afdian/webhook", { form: buildCallback(noRemark) });
  const list4 = await call("GET", "/api/admin/afdian?filter=unbound", { admin: true });
  eq("没留言的订单进入待绑定队列", list4.body.items.length, 1);
  eq("待绑定统计正确", list4.body.stats.unbound, 1);

  const unpaid = orderPayload({ remark: "我的 uuid " + uuid, status: 1, out_trade_no: "ORDER-1004" });
  await call("POST", "/api/afdian/webhook", { form: buildCallback(unpaid) });
  const list5 = await call("GET", "/api/admin/afdian", { admin: true });
  const unpaidRow = list5.body.items.find((o) => o.outTradeNo === "ORDER-1004");
  ok("未支付订单只记录不发奖", String(unpaidRow.reward).includes("未发奖"), unpaidRow.reward);

  console.log("\n后台手动绑定");
  const unboundId = list4.body.items[0].id;
  const bound = await call("POST", "/api/admin/afdian/orders/" + unboundId + "/bind", { body: { uuid }, admin: true });
  eq("绑定成功", bound.status, 200);
  ok("绑定后按档位发放了头衔", String(bound.body.reward).includes("头衔"), bound.body.reward);

  const badBind = await call("POST", "/api/admin/afdian/orders/" + unboundId + "/bind", { body: { uuid: "not-a-uuid" }, admin: true });
  eq("绑定不存在的用户被拒", badBind.body.error, "user_not_found");

  const ignore = await call("POST", "/api/admin/afdian/orders/" + unboundId + "/ignore", { admin: true });
  eq("可以忽略一单", ignore.status, 200);

  console.log("\n统计与权限");
  const stats = (await call("GET", "/api/admin/afdian", { admin: true })).body.stats;
  eq("总单数", stats.total, 4);
  eq("已支付单数", stats.paid, 3);
  eq("金额按分累加（3 × 5.00）", stats.amount, "15.00");
  ok("回调就绪标记正确", stats.webhookReady === true && stats.apiReady === true);
  eq("档位表下发到后台（2 档）", (stats.tiers || []).length, 2);

  eq("未带令牌访问被拒", (await call("GET", "/api/admin/afdian")).status, 401);

  console.log("\n按金额分档发奖（全自动，无需审批）");
  const tierOrder = (amount, remark, no) => orderPayload({
    out_trade_no: no, total_amount: amount, show_amount: amount, remark
  });

  // 先把用户身上的赞助头衔清掉，逐档验证
  await call("POST", "/api/admin/users/1", { body: { action: "set_title", value: null }, admin: true });

  const five = tierOrder("5.00", "标识 " + uuid, "TIER-5");
  await call("POST", "/api/afdian/webhook", { form: buildCallback(five) });
  let me2 = await call("GET", "/api/auth/me");
  eq("发电 5 元 → 固定头衔「股东」", me2.body.user.title && me2.body.user.title.name, "股东");

  const ten = tierOrder("10.00", "标识 " + uuid + " 头衔：夜跑的阿哲", "TIER-10");
  await call("POST", "/api/afdian/webhook", { form: buildCallback(ten) });
  me2 = await call("GET", "/api/auth/me");
  eq("发电 10 元 → 留言里自定义的头衔", me2.body.user.title && me2.body.user.title.name, "夜跑的阿哲");

  const tenBad = tierOrder("10.00", "标识 " + uuid + " 头衔：管理员小助手", "TIER-BAD");
  await call("POST", "/api/afdian/webhook", { form: buildCallback(tenBad) });
  const badRow = (await call("GET", "/api/admin/afdian?filter=all", { admin: true }))
    .body.items.find((o) => o.outTradeNo === "TIER-BAD");
  ok("自定义头衔冒名官方时被预审拦下并记录原因",
    String(badRow.reward).includes("不可用"), badRow.reward);
  me2 = await call("GET", "/api/auth/me");
  eq("被拦下后回落到固定档「股东」", me2.body.user.title.name, "股东");

  const tooSmall = tierOrder("4.99", "标识 " + uuid, "TIER-SMALL");
  await call("POST", "/api/afdian/webhook", { form: buildCallback(tooSmall) });
  const smallRow = (await call("GET", "/api/admin/afdian?filter=all", { admin: true }))
    .body.items.find((o) => o.outTradeNo === "TIER-SMALL");
  ok("未达最低档只记录不发奖", String(smallRow.reward).includes("未达到发奖档位"), smallRow.reward);

  // 管理员手动指派的头衔不该被赞助顶掉
  const manual = await call("POST", "/api/admin/titles", { body: { name: "版主", minLevel: 1, auto: false }, admin: true });
  await call("POST", "/api/admin/users/1", { body: { action: "set_title", value: manual.body.id }, admin: true });
  const tenAgain = tierOrder("10.00", "标识 " + uuid + " 头衔：另一个名字", "TIER-MANUAL");
  await call("POST", "/api/afdian/webhook", { form: buildCallback(tenAgain) });
  me2 = await call("GET", "/api/auth/me");
  eq("管理员手动指派的头衔不被赞助覆盖", me2.body.user.title.name, "版主");
  const manualRow = (await call("GET", "/api/admin/afdian?filter=all", { admin: true }))
    .body.items.find((o) => o.outTradeNo === "TIER-MANUAL");
  ok("不覆盖时也如实记录原因", String(manualRow.reward).includes("未覆盖"), manualRow.reward);

  // 赞助头衔之间可以逐档升级（股东 → 自定义）
  await call("POST", "/api/admin/users/1", { body: { action: "set_title", value: null }, admin: true });
  await call("POST", "/api/afdian/webhook", { form: buildCallback(tierOrder("5.00", "标识 " + uuid, "TIER-UP-5")) });
  await call("POST", "/api/afdian/webhook", { form: buildCallback(tierOrder("10.00", "标识 " + uuid + " 头衔：升级版", "TIER-UP-10")) });
  me2 = await call("GET", "/api/auth/me");
  eq("赞助头衔可以逐档升级（股东 → 自定义）", me2.body.user.title.name, "升级版");

  const site2 = await call("GET", "/api/site");
  ok("档位规则随站点信息下发（前端据此展示）",
    Array.isArray(site2.body.afdian.tiers) && site2.body.afdian.tiers.length === 2
    && site2.body.afdian.customKeyword === "头衔", site2.body.afdian);

  console.log("\n=== 通过 " + passed + " / 失败 " + failed + " ===");
  if (failed) {
    console.log("失败项：" + failures.join("、"));
    console.log(serverLog.split("\n").slice(-25).join("\n"));
  }
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error("测试崩溃：" + ((err && err.stack) || err));
  console.log(serverLog.split("\n").slice(-30).join("\n"));
  cleanup();
  process.exit(1);
});
