/**
 * Turnstile 连通性诊断（手动运行，不进 CI）。
 *
 * 回答两个问题：
 *   1. 服务端是否启用了 Turnstile、下发的 siteKey 对不对；
 *   2. 浏览器里 widget 脚本能不能加载、能不能拿到 token。
 *
 * 两种用法：
 *   - 官方测试 key（验证集成代码本身，任意域名可用）：
 *       $env:TURNSTILE_SITE_KEY='1x00000000000000000000AA'
 *       $env:TURNSTILE_SECRET_KEY='1x0000000000000000000000000000000AA'
 *       node scripts/turnstile-live-check.mjs
 *   - 真实 key（读 server/.env，验证线上配置）：
 *       node scripts/turnstile-live-check.mjs
 *
 * 注意：真实 key 在无头浏览器里通常会被判为自动化，Turnstile 不下发挑战
 * （表现为脚本已加载、但 widget 不出 iframe、拿不到 token）。
 * 这是环境限制，不代表集成有问题 —— 真实浏览器里人工点一次才算最终验收。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpPage, launchBrowser } from './lib/cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PORT = 9500 + Math.floor(Math.random() * 90);
const BASE = 'http://127.0.0.1:' + PORT;
const TMP = mkdtempSync(join(tmpdir(), 'wall-ts-live-'));

const overrides = {};
if (process.env.TURNSTILE_SITE_KEY) overrides.TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY;
if (process.env.TURNSTILE_SECRET_KEY) overrides.TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY;
const usingTestKeys = Boolean(overrides.TURNSTILE_SITE_KEY);

const server = spawn(process.execPath, [join(ROOT, 'server', 'src', 'server.js')], {
  cwd: join(ROOT, 'server'),
  env: Object.assign({}, process.env, {
    NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(PORT),
    DB_PATH: join(TMP, 'live.db'), AUTH_CODE_ECHO: '1'
  }, overrides),
  stdio: ['ignore', 'pipe', 'pipe']
});
let log = '';
server.stdout.on('data', (c) => { log += String(c); });
server.stderr.on('data', (c) => { log += String(c); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanup() {
  try { server.kill(); } catch { /* ignore */ }
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}

(async () => {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try { if ((await fetch(BASE + '/api/health')).ok) break; } catch { /* wait */ }
    await sleep(200);
  }
  const site = await (await fetch(BASE + '/api/site')).json();
  console.log('① 服务端配置');
  console.log('   启用:', Boolean(site.turnstile), '| siteKey:', site.turnstile ? site.turnstile.siteKey : '（无）',
    '| action:', site.turnstile ? site.turnstile.action : '（无）', usingTestKeys ? '（官方测试 key）' : '（真实 key）');
  if (!site.turnstile) {
    cleanup();
    console.log('\n服务端没启用 Turnstile：确认 server/.env 里 TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY 都在。');
    console.log('启动日志：\n' + log.split('\n').slice(-6).join('\n'));
    process.exit(2);
  }

  const browser = await launchBrowser({});
  const page = await CdpPage.open(browser.wsUrl);
  await page.setup();
  let token = '';
  try {
    await page.goto(BASE + '/', { waitMs: 900 });
    await page.eval('document.querySelector(".dock-compose").click(); true');
    await page.waitFor('!!document.querySelector(".sheet-panel")');
    await page.eval("(() => { const b = Array.from(document.querySelectorAll('.sheet-panel .btn')).find((x) => x.textContent.includes('去登录')); if (b) b.click(); return true; })()");
    await page.waitFor('!!document.querySelector("#auth-email")', { timeout: 8000 });
    // 先填邮箱：否则发码按钮因「邮箱为空」而禁用，会把「没人机验证」误判成「人机验证没过」
    await page.eval("(() => { const el = document.querySelector('#auth-email'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, 'probe@example.com'); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");

    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      token = await page.eval("(() => { const el = document.querySelector('[name=\"cf-turnstile-response\"]'); return el ? el.value : ''; })()");
      if (token) break;
      await sleep(500);
    }
    const glob = await page.eval('typeof window.turnstile');
    const enabled = await page.eval("(() => { const b = document.querySelector('.sheet-panel .btn-primary'); return b ? !b.disabled : false; })()");
    console.log('\n② 浏览器侧');
    console.log('   turnstile 脚本已加载:', glob === 'object');
    console.log('   已拿到 token:', token ? '是（长度 ' + token.length + '）' : '否');
    console.log('   发码按钮可点:', enabled);
  } finally {
    await browser.close();
  }

  cleanup();
  if (token) {
    console.log('\n结论：widget → token 链路正常。' + (usingTestKeys ? '（测试 key 的 token 是 dummy，服务端会因 action/hostname 缺失而拒绝，属预期）' : ''));
    process.exit(0);
  }
  console.log('\n结论：脚本加载了但没拿到 token。');
  console.log('  · 无头浏览器被判定为自动化 → Turnstile 不下发挑战（环境限制，真实浏览器里人工点一次即可）；');
  console.log('  · 或该 widget 的 Hostname Management 里没有当前域名（生产域名 / 本地 localhost 都要加）。');
  process.exit(1);
})().catch((err) => {
  console.error('诊断崩溃：' + ((err && err.stack) || err));
  console.log(log.split('\n').slice(-15).join('\n'));
  cleanup();
  process.exit(1);
});
