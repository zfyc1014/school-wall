/**
 * 后台（/houtai/）浏览器冒烟测试。
 *
 * 为什么单独有这一个：后台是单文件、无构建的原生 JS，删/改代码没有编译期保护。
 * 这次删掉整套「演示模式」后尤其需要一次真实渲染验证：面板能不能连上后端、
 * 各视图能不能渲染、有没有未捕获异常。
 *
 * 用法：node scripts/admin-e2e.mjs
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpPage, launchBrowser } from './lib/cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PORT = 8900 + Math.floor(Math.random() * 90);
const BASE = 'http://127.0.0.1:' + PORT;
const ADMIN_TOKEN = 'admin-e2e-token-0123456789abcdef';
const IP_SECRET = 'admin-e2e-ip-secret-0123456789abcdef';
const AFDIAN_TOKEN = 'admin-e2e-afdian-token';
const AFDIAN_USER_ID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const TMP = mkdtempSync(join(tmpdir(), 'wall-admin-'));
const SHOTS = join(ROOT, 'web', 'screenshots');

let passed = 0;
let failed = 0;
const failures = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ok(name, cond, detail) {
  if (cond) { passed += 1; console.log('  ✓ ' + name); }
  else { failed += 1; failures.push(name); console.log('  ✗ ' + name + (detail === undefined ? '' : '  → ' + JSON.stringify(detail))); }
}

const server = spawn(process.execPath, [join(ROOT, 'server', 'src', 'server.js')], {
  cwd: join(ROOT, 'server'),
  env: {
    ...process.env,
    OD_SKIP_ENV_FILE: '1', NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(PORT),
    DB_PATH: join(TMP, 'admin.db'), OUTBOX_DIR: join(TMP, 'outbox'),
    ADMIN_TOKEN, IP_HASH_SECRET: IP_SECRET, AUTH_CODE_ECHO: '1', FORCE_HTTPS: '0',
    AFDIAN_USER_ID, AFDIAN_TOKEN, AFDIAN_PAGE: 'https://afdian.com/a/school-wall'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', (c) => { serverLog += String(c); });
server.stderr.on('data', (c) => { serverLog += String(c); });

function cleanup() {
  try { server.kill(); } catch { /* ignore */ }
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}

async function waitForServer() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try { if ((await fetch(BASE + '/api/health')).ok) return; } catch { /* wait */ }
    await sleep(200);
  }
  throw new Error('后端未启动\n' + serverLog);
}

async function api(path, { method = 'GET', body, admin = false, form } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (form !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
  if (admin) headers.authorization = 'Bearer ' + ADMIN_TOKEN;
  const res = await fetch(BASE + path, { method, headers, body: form !== undefined ? form : (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, body: json, setCookie: (res.headers.getSetCookie() || []).join('; ') };
}

/** 造一笔爱发电订单（签名照官方算法，独立实现） */
function afdianCallback(order) {
  const inner = JSON.stringify({ type: 'order', order });
  const ts = Math.floor(Date.now() / 1000);
  const sign = crypto.createHash('md5')
    .update(AFDIAN_TOKEN + 'params' + inner + 'ts' + ts + 'user_id' + AFDIAN_USER_ID, 'utf8').digest('hex');
  const envelope = JSON.stringify({ user_id: AFDIAN_USER_ID, params: inner, ts, sign });
  return 'params=' + encodeURIComponent(envelope) + '&sign=' + encodeURIComponent(sign);
}

/** 给受控输入框赋值（走原生 setter + input 事件，否则 React 收不到） */
const setInputLocal = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`;

async function main() {
  await waitForServer();

  // 前置数据：学校 + 用户 + 一条待审帖子 + 一笔赞助
  await api('/api/admin/schools', { method: 'POST', body: { name: '管理大学' }, admin: true });
  const code = await api('/api/auth/code', { method: 'POST', body: { email: 'admin-e2e@example.com' } });
  const verified = await api('/api/auth/verify', { method: 'POST', body: { email: 'admin-e2e@example.com', code: code.body.devCode } });
  const reg = await api('/api/auth/register', {
    method: 'POST', body: { token: verified.body.token, nickname: '待审同学', school: '管理大学' }
  });
  const cookie = reg.setCookie.split(';')[0];
  const post = await api('/api/posts', { method: 'POST', body: { cat: '表白', body: '这条帖子等着被审核' }, });
  void post;

  await api('/api/afdian/webhook', {
    method: 'POST', form: afdianCallback({
      out_trade_no: 'ADMIN-E2E-1', user_id: AFDIAN_USER_ID, plan_id: 'p1', month: 1,
      total_amount: '5.00', show_amount: '5.00', status: 2, remark: '我的 uuid ' + reg.body.user.uuid,
      created_at: Math.floor(Date.now() / 1000)
    })
  });
  void cookie;

  const browser = await launchBrowser({});
  const page = await CdpPage.open(browser.wsUrl);
  await page.setup();

  try {
    // 页面里记录未捕获异常，最后统一断言
    await page.send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'window.__errors = []; window.addEventListener("error", (e) => window.__errors.push(String(e.message))); window.addEventListener("unhandledrejection", (e) => window.__errors.push("rejection: " + String(e.reason)));'
    });

    // 令牌存在 localStorage 里，先写进去再进后台
    await page.goto(BASE + '/', { waitMs: 300 });
    await page.eval('localStorage.setItem("od_admin_token", ' + JSON.stringify(ADMIN_TOKEN) + '); true');
    await page.goto(BASE + '/houtai/', { waitMs: 1200 });
    await page.waitFor('!!document.querySelector(".nav-rail")', { timeout: 8000 });

    const conn = await page.eval('document.querySelector("#connText").innerText');
    ok('后台连上真实后端（不再是演示模式）', conn.includes('已连接'), conn);
    const bodyText = await page.eval('document.body.innerText');
    ok('页面里没有任何「演示」字样', !bodyText.includes('演示'));
    ok('页面里没有「示例大学」这类假数据', !bodyText.includes('示例大学'));

    // 概览
    await page.waitFor('document.body.innerText.includes("概览")', { timeout: 5000 });
    const overview = await page.eval('document.querySelector("#view-overview").innerText');
    ok('概览渲染出待审数据（真实数字）', /待审|帖子|用户/.test(overview), overview.slice(0, 80));

    // 赞助视图
    await page.eval('document.querySelector(\'[data-view="afdian"]\').click(); true');
    await page.waitFor('location.hash.includes("afdian") || document.querySelector("#view-afdian").hidden === false', { timeout: 5000 });
    await page.waitFor('document.querySelector("#view-afdian").innerText.length > 40', { timeout: 6000 });
    const afdianText = await page.eval('document.querySelector("#view-afdian").innerText');
    ok('赞助视图渲染出订单', afdianText.includes('ADMIN-E2E-1'), afdianText.slice(0, 120));
    ok('赞助视图显示匹配到的用户', afdianText.includes('待审同学'), afdianText.slice(0, 160));
    // 回调地址渲染在只读 input 的 value 里（innerText 取不到），直接断言它的取值
    const hook = await page.eval('(document.querySelector("#afWebhook") || {}).value || ""');
    ok('赞助视图给出可直接粘贴的回调地址', hook === BASE + '/api/afdian/webhook', hook);
    ok('回调地址旁有说明文案', afdianText.includes('回调地址'));

    // 用户视图
    await page.eval('document.querySelector(\'[data-view="users"]\').click(); true');
    await page.waitFor('document.querySelector("#view-users").innerText.includes("待审同学")', { timeout: 6000 });
    ok('用户视图渲染出真实用户', true);

    mkdirSync(SHOTS, { recursive: true });
    await page.eval('document.querySelector(\'[data-view="afdian"]\').click(); true');
    await sleep(600);
    await page.metrics({ width: 1440, height: 900, mobile: false });
    await page.screenshot(join(SHOTS, '05-admin-afdian.png'));
    ok('产出后台赞助页截图', true);

    // 后台「首页」视图：能打开、编辑器可见可输入（v1.0.1 新增；此前漏在 VIEW_IDS 白名单外导致空白）
    await page.eval('document.querySelector(\'[data-view="home"]\').click(); true');
    await page.waitFor('(() => { const v = document.querySelector("#view-home"); return !!v && !v.hidden && !!document.querySelector("#homeMd"); })()', { timeout: 8000 });
    const homeViewState = await page.eval('(() => { const v = document.querySelector("#view-home"); const ta = document.querySelector("#homeMd"); return { hidden: v ? v.hidden : null, hasEditor: !!ta, display: ta ? getComputedStyle(ta).display : "", valueLen: ta ? ta.value.length : -1 }; })()');
    ok('首页视图能打开且 Markdown 编辑器可见', homeViewState.hidden === false && homeViewState.hasEditor && homeViewState.display !== 'none', homeViewState);
    await page.eval(setInputLocal('#homeMd', '## 后台测试首页\n\n- 第一行\n- 第二行'));
    const typed = await page.eval('document.querySelector("#homeMd").value.includes("后台测试首页")');
    ok('Markdown 编辑器可输入', typed);
    await page.eval('document.querySelector(\'[data-act="home.save"]\').click(); true');
    // 保存前会弹确认框（#modalCard 里的 [data-confirm]）
    await page.waitFor('!!document.querySelector("#modalCard [data-confirm]")', { timeout: 6000 });
    await page.eval('document.querySelector("#modalCard [data-confirm]").click(); true');
    await page.waitFor('!document.querySelector("#modal") || document.querySelector("#modal").hidden', { timeout: 6000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 600));
    const saved = await (await fetch(BASE + '/api/home')).json().catch(() => ({}));
    ok('保存后前台接口能读到新内容', String(saved.markdown || '').includes('后台测试首页'), String(saved.markdown || '').slice(0, 40));

    // 邮件通道自检卡片（验证码是唯一登录入口，配置状态必须在后台一眼可见）
    // 注意用 textContent 而不是 innerText：innerText 对隐藏元素返回空串，
    // 而这里刚切回概览视图，渲染还没完成。
    await page.eval('document.querySelector(\'[data-view="overview"]\').click(); true');
    await page.waitFor('(document.querySelector("#view-overview") || {}).textContent.includes("邮件通道")', { timeout: 8000 });
    const hasTestBtn = await page.eval('!!document.querySelector(\'[data-act="email.test"]\') && !!document.querySelector("#emailTestTo")');
    ok('概览有「邮件通道」卡片且带测试按钮', hasTestBtn);
    const emailHint = await page.eval('document.querySelector("#view-overview").textContent.includes("未配置 CF_ACCOUNT_ID")');
    ok('未配置时卡片如实给出告警（而不是假装正常）', emailHint);

    // 来源与设备（IP 粗粒度画像）
    await page.eval('document.querySelector(\'[data-view="overview"]\').click(); true');
    await page.waitFor('(document.querySelector("#view-overview") || {}).textContent.includes("来源与设备")', { timeout: 8000 });
    ok('概览有「来源与设备」卡片', true);

    // 用户详情：更多信息 + 更多操作
    await page.eval('document.querySelector(\'[data-view="users"]\').click(); true');
    await page.waitFor('document.querySelector("#view-users").textContent.includes("待审同学")', { timeout: 8000 });
    await page.eval('document.querySelector(\'[data-act="user.open"]\').click(); true');
    await page.waitFor('!!document.querySelector("#modalCard") && document.querySelector("#modalCard").textContent.includes("管理操作")', { timeout: 8000 });
    const detailText = await page.eval('document.querySelector("#modalCard").textContent');
    ok('用户详情显示手机号与 IP 来源', detailText.includes('手机号') && detailText.includes('IP 来源'));
    ok('用户详情显示在线会话', detailText.includes('在线会话'));
    ok('用户详情提供「强制下线 / 解绑手机号」操作',
      detailText.includes('强制下线') && detailText.includes('解绑手机号'));
    await page.eval('document.querySelector("#modalCard [data-close]").click(); true');

    const errors = await page.eval('window.__errors || []');
    ok('没有未捕获的 JS 异常', Array.isArray(errors) && errors.length === 0, errors);

    console.log('\n=== 通过 ' + passed + ' / 失败 ' + failed + ' ===');
    if (failed) {
      console.log('失败项：' + failures.join('、'));
      console.log(serverLog.split('\n').slice(-20).join('\n'));
    }
  } finally {
    await browser.close();
    cleanup();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('后台冒烟崩溃：' + ((err && err.stack) || err));
  console.log(serverLog.split('\n').slice(-25).join('\n'));
  cleanup();
  process.exit(1);
});
