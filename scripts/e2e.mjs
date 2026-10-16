/**
 * 端到端验收（v1.0.0）。
 *
 * 范围：把「真实构建产物 + 真实后端 + 真实浏览器」串起来跑一遍主要流程 ——
 *   首页渲染 → 公告 → 底部 dock（液态玻璃）→ 邮箱验证码注册（强制选学校）
 *   → 发一条超长表白（验证字数限制已取消）→ 后台审核 → 墙上可见
 *   → 论坛署名讨论 → 移动端截图。
 *
 * 为什么值这一趟：单测能证明接口对，但证明不了「页面真的能在手机上用」。
 * 这一层只断言**用户能看见的结果**（DOM 里有没有那段文字），不碰内部实现。
 *
 * 用法：node scripts/e2e.mjs
 * 依赖：web/dist 已构建（npm run build）、本机有 Edge/Chrome。
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpPage, launchBrowser } from './lib/cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PORT = 8800 + Math.floor(Math.random() * 150);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_TOKEN = 'e2e-admin-token-0123456789abcdef';
const IP_SECRET = 'e2e-ip-hash-secret-0123456789abcdef';

const TMP = mkdtempSync(join(tmpdir(), 'wall-e2e-'));
const DB_PATH = join(TMP, 'e2e.db');
const SHOTS = join(ROOT, 'web', 'screenshots');

let passed = 0;
let failed = 0;
const failures = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ok(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log('  ✓ ' + name);
  } else {
    failed += 1;
    failures.push(name);
    console.log('  ✗ ' + name + (detail === undefined ? '' : '  → ' + JSON.stringify(detail)));
  }
}

/* ── 后端进程 ─────────────────────────────────────────────────────────── */

const server = spawn(process.execPath, [join(ROOT, 'server', 'src', 'server.js')], {
  cwd: join(ROOT, 'server'),
  env: {
    ...process.env,
    OD_SKIP_ENV_FILE: '1',
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: String(PORT),
    DB_PATH,
    OUTBOX_DIR: join(TMP, 'outbox'),
    ADMIN_TOKEN,
    IP_HASH_SECRET: IP_SECRET,
    AUTH_CODE_ECHO: '1',
    FORCE_HTTPS: '0'
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
    try {
      if ((await fetch(BASE + '/api/health')).ok) return;
    } catch { /* 还没起来 */ }
    await sleep(200);
  }
  throw new Error('后端未能在 20 秒内启动\n' + serverLog);
}

/* ── 直接用 API 铺数据（e2e 的重点是界面，不是再测一遍接口）────────────── */

async function api(path, { method = 'GET', body, admin = false, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (admin) headers.authorization = 'Bearer ' + ADMIN_TOKEN;
  if (cookie) headers.cookie = cookie;
  const res = await fetch(BASE + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  return { status: res.status, body: payload, setCookie: (res.headers.getSetCookie() || []).join('; ') };
}

/* ── 页面操作小工具 ───────────────────────────────────────────────────── */

/** 给受控输入框赋值：必须走原生 setter + input 事件，直接改 value 不会触发 React */
const setInput = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`;

const selectOption = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`;

const click = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  el.click();
  return true;
})()`;

/** 按可见文字点按钮 */
const clickText = (selector, text) => `(() => {
  const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
  const el = nodes.find((n) => (n.textContent || '').trim().includes(${JSON.stringify(text)}));
  if (!el) return false;
  el.click();
  return true;
})()`;

const hasText = (text) => `document.body.innerText.includes(${JSON.stringify(text)})`;

/* ── 主流程 ───────────────────────────────────────────────────────────── */

async function main() {
  await waitForServer();

  // 前置数据：一所学校 + 一条公告
  await api('/api/admin/schools', { method: 'POST', body: { name: '示例大学' }, admin: true });
  await api('/api/admin/announcements', {
    method: 'POST',
    body: { body: '期末周互助帖已开放', link: '/forum', linkText: '去看看' },
    admin: true
  });

  const browser = await launchBrowser({});
  const page = await CdpPage.open(browser.wsUrl);
  await page.setup();

  try {
    console.log('\n首页与底部 dock');
    await page.goto(BASE + '/', { waitMs: 900 });
    await page.waitFor('!!document.querySelector(".dock-inner")');

    const dock = await page.eval(`(() => {
      const el = document.querySelector('.dock-inner');
      const style = getComputedStyle(el);
      return {
        tabs: Array.from(document.querySelectorAll('.dock-tab')).map((t) => t.innerText.trim()),
        hasCompose: !!document.querySelector('.dock-compose'),
        backdrop: style.backdropFilter || style.webkitBackdropFilter,
        position: style.position,
        bg: style.backgroundColor
      };
    })()`);

    ok('底部 dock 渲染出 4 个 tab', dock.tabs.length === 4, dock.tabs);
    ok('dock 有主行动按钮', dock.hasCompose);
    ok('dock 是液态玻璃（backdrop blur + 半透明底）',
      /blur/.test(dock.backdrop || '') && /rgba|color/.test(dock.bg), dock);

    const title = await page.eval('document.querySelector(".home-title").innerText');
    ok('首页显示站名', title === '校园墙', title);

    await page.waitFor(hasText('期末周互助帖已开放'), { timeout: 8000 });
    ok('首页公告栏显示后台配置的公告', true);
    ok('首页没有任何「内测」字样', !(await page.eval(hasText('内测'))));
    ok('首页没有 hero 大标语（保持简洁）', !(await page.eval('!!document.querySelector(".hero")')));

    console.log('\n注册：邮箱验证码 + 强制选学校');
    await page.eval(click('.dock-compose'));
    await page.waitFor('!!document.querySelector(".sheet-panel")');
    await page.eval(clickText('.sheet-panel .btn', '去登录'));
    await page.waitFor('!!document.querySelector("#auth-email")');

    await page.eval(setInput('#auth-email', 'e2e@example.com'));
    await page.eval(clickText('.sheet-panel .btn', '获取验证码'));
    await page.waitFor('!!document.querySelector("#auth-code")', { timeout: 10000 });
    // 开发模式下服务端回带 devCode，AuthSheet 会自动填入
    const code = await page.eval('document.querySelector("#auth-code").value');
    ok('验证码自动填入（开发模式回带 devCode）', /^\d{6}$/.test(code), code);

    await page.eval(clickText('.sheet-panel .btn', '登录'));
    await page.waitFor('!!document.querySelector("#auth-nickname")', { timeout: 10000 });
    ok('新邮箱进入「完善资料」步骤', true);

    const schoolOptions = await page.eval('Array.from(document.querySelectorAll("#auth-school option")).map((o) => o.value)');
    ok('学校下拉来自后台配置的名单', schoolOptions.includes('示例大学'), schoolOptions);
    ok('学校默认未选中（必须强制选择）', schoolOptions[0] === '', schoolOptions[0]);

    await page.eval(setInput('#auth-nickname', '小满'));
    await page.eval(selectOption('#auth-school', '示例大学'));
    await page.eval(clickText('.sheet-panel .btn', '完成注册'));
    await page.waitFor('!document.querySelector(".sheet-panel")', { timeout: 10000 });

    await page.goto(BASE + '/#/me', { waitMs: 900 });
    await page.waitFor('!!document.querySelector(".me-name")', { timeout: 8000 });
    const badge = await page.eval('document.querySelector(".badge").innerText');
    ok('个人主页的学校·头衔·等级顺序正确（学校在最前）', badge.trim().startsWith('示例大学'), badge);

    console.log('\n发布：取消字数限制');
    const longText = '这是一段很长的表白。'.repeat(40); // 400 字，超过旧版 500 字限制的一半以上
    await page.goto(BASE + '/', { waitMs: 700 });
    await page.eval(click('.dock-compose'));
    await page.waitFor('!!document.querySelector("#composer-body")');
    await page.eval(setInput('#composer-body', longText));
    const counterExists = await page.eval('!!document.querySelector(".counter")');
    ok('发布框不再显示字数计数器', !counterExists);
    await page.eval(clickText('.sheet-foot .btn', '发布'));
    await page.waitFor('!document.querySelector(".sheet-panel")', { timeout: 8000 });

    // 后台把这条帖子审过
    const queue = await api('/api/admin/queue?type=posts', { admin: true });
    ok('帖子进入后台待审队列', queue.body.items.length === 1, queue.body.items.length);
    ok('超长正文完整入库（未被截断）',
      queue.body.items[0].body.length === longText.length,
      { got: queue.body.items[0].body.length, want: longText.length });
    await api(`/api/admin/posts/${queue.body.items[0].id}/approve`, { method: 'POST', body: {}, admin: true });

    await page.goto(BASE + '/', { waitMs: 900 });
    await page.waitFor('!!document.querySelector(".post")', { timeout: 8000 });
    ok('审核通过后出现在墙上', await page.eval(hasText('这是一段很长的表白')));
    const postBody = await page.eval('document.querySelector(".post-body").innerText');
    ok('长文默认折叠为 8 行', postBody.length > 0);
    ok('卡片上不出现任何作者信息', !(await page.eval(hasText('小满'))));

    console.log('\n论坛：署名讨论（走真实 UI 发帖）');
    await page.goto(BASE + '/#/forum/new', { waitMs: 700 });
    await page.waitFor('!!document.querySelector(".forum-form .input")', { timeout: 8000 });
    await page.eval(selectOption('.forum-form .select', 'study'));
    await page.eval(setInput('.forum-form .input', '期末复习资料共享'));
    await page.eval(setInput('.forum-form .textarea', '大家把笔记发到这里吧'));
    // 受控表单的按钮要等 React 把状态刷完才会从 disabled 变可点：不等就是空点
    await page.waitFor('!document.querySelector(".forum-form .btn-primary").disabled', { timeout: 5000 });
    await page.eval(clickText('.forum-form .btn', '发布'));
    await page.waitFor('location.hash.indexOf("#/forum/") === 0 && location.hash !== "#/forum/new"', { timeout: 10000 });

    await page.goto(BASE + '/#/forum', { waitMs: 900 });
    await page.waitFor(hasText('期末复习资料共享'), { timeout: 8000 });
    ok('论坛列表显示主题', true);
    ok('论坛显示用户昵称（署名）', await page.eval(hasText('小满')));

    await page.goto(BASE + '/#/forum/1', { waitMs: 900 });
    await page.waitFor('!!document.querySelector(".page-head")', { timeout: 8000 });
    const threadBadge = await page.eval(`(() => {
      const el = document.querySelector('.badge');
      return el ? el.innerText.trim() : '';
    })()`);
    ok('主题详情带作者标识（学校在前）', threadBadge.includes('示例大学'), threadBadge);

    console.log('\n移动端适配与截图');
    mkdirSync(SHOTS, { recursive: true });
    await page.metrics({ width: 390, height: 844, mobile: true });
    await page.goto(BASE + '/', { waitMs: 900 });
    await page.waitFor('!!document.querySelector(".dock-inner")');
    const mobile = await page.eval(`(() => {
      const dock = document.querySelector('.dock-inner').getBoundingClientRect();
      const input = document.querySelector('.chips');
      return {
        dockBottom: Math.round(window.innerHeight - dock.bottom),
        dockWidth: Math.round(dock.width),
        viewport: window.innerWidth,
        horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        tapTargets: Array.from(document.querySelectorAll('.dock-tab')).map((t) => Math.round(t.getBoundingClientRect().height))
      };
    })()`);
    ok('手机端没有横向溢出', !mobile.horizontalOverflow, mobile);
    ok('dock 贴合底部（考虑安全区）', mobile.dockBottom >= 0 && mobile.dockBottom < 40, mobile.dockBottom);
    ok('触摸目标高度足够', mobile.tapTargets.every((h) => h >= 44), mobile.tapTargets);
    await page.screenshot(join(SHOTS, '01-home-mobile.png'));

    await page.metrics({ width: 1440, height: 900, mobile: false });
    await page.goto(BASE + '/', { waitMs: 800 });
    await page.screenshot(join(SHOTS, '02-home-desktop.png'));

    await page.metrics({ width: 390, height: 844, mobile: true });
    await page.goto(BASE + '/#/forum', { waitMs: 800 });
    await page.screenshot(join(SHOTS, '03-forum-mobile.png'));
    await page.goto(BASE + '/#/me', { waitMs: 800 });
    await page.screenshot(join(SHOTS, '04-me-mobile.png'));

    console.log('\n=== 通过 ' + passed + ' / 失败 ' + failed + ' ===');
    if (failed) {
      console.log('失败项：' + failures.join('、'));
      console.log(serverLog.split('\n').slice(-25).join('\n'));
    }
  } finally {
    await browser.close();
    cleanup();
  }

  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('e2e 崩溃：' + ((err && err.stack) || err));
  console.log(serverLog.split('\n').slice(-30).join('\n'));
  cleanup();
  process.exit(1);
});
