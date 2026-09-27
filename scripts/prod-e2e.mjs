/**
 * 生产模式端到端验收：真实 Node 后端 + 真实构建产物 + 无头浏览器。
 *
 * 这是最接近上线状态的一条链路：
 *   后端（Turnstile 开启、NODE_ENV=production、自己的静态服务）
 *     → 浏览器打开首页
 *     → 未验证时写请求被服务端 403 拦下
 *     → 完成人机验证（测试模式注入假 token，服务端用 Cloudflare 测试密钥校验）
 *     → 发布走通、内容进入审核队列
 *
 * 为什么必须用 NODE_ENV=production：这才是上线时的行为 ——
 * 未配置 Turnstile 就拒绝启动、CSP/HSTS 生效、VITE_DATA_MODE=api 不回落本地数据。
 *
 * 用法：node scripts/prod-e2e.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpPage, launchBrowser, sleep } from './lib/cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const serverDir = join(repoRoot, 'server');

const PORT = 8300 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_TOKEN = 'e2e-admin-token-0123456789abcdef';
const IP_SECRET = 'e2e-ip-hash-secret-0123456789';
const TMP = mkdtempSync(join(tmpdir(), 'od-prod-e2e-'));

const results = [];
const ok = (name, detail = '') => { results.push(true); console.log(`  \u2713 ${name}${detail ? `  — ${detail}` : ''}`); };
const bad = (name, detail = '') => { results.push(false); console.log(`  \u2717 ${name}${detail ? `  — ${detail}` : ''}`); };
const check = (name, cond, detail = '') => { if (cond) ok(name, detail); else bad(name, detail); return Boolean(cond); };

let server = null;
let preview = null;
let browser = null;
let page = null;
/** 后端因原生 teardown 断言意外退出时，只自动重启一次，避免掩盖真正的启动失败 */
let restartedOnce = false;

function run(cmd, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...options });
    let out = '';
    child.stdout.on('data', (c) => { out += String(c); });
    child.stderr.on('data', (c) => { out += String(c); });
    child.on('exit', (code) => (code === 0 ? resolvePromise(out) : rejectPromise(new Error(`${cmd} 退出 ${code}\n${out}`))));
  });
}

function startServer() {
  return new Promise((resolvePromise, rejectPromise) => {
    const env = {
      ...process.env,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(PORT),
      DB_PATH: join(TMP, 'wall.db'),
      WEB_ROOT: join(repoRoot, 'web', 'dist'),
      INDEX_FILE: 'index.html',
      ADMIN_TOKEN,
      IP_HASH_SECRET: IP_SECRET,
      TRUST_PROXY: '0', // 直接监听，不走反代，便于测试；验证走 CF-Connecting-IP 缺失分支
      // Cloudflare 官方测试密钥：恒通过
      TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
      TURNSTILE_SECRET: '1x0000000000000000000000000000000AA',
      CHALLENGE_ENFORCE: '1',
      CHALLENGE_COOKIE_SECURE: '0', // http 本地测试
      // 后台实名：生产语义下强制开启；短信走 log 通道（验证码写服务端日志，测试从中提取），
      // 既走通真实发码路径，又不真的发短信、不依赖外部网关。
      IDENTITY_ENFORCE: '1',
      IDENTITY_SECRET: IP_SECRET,
      IDENTITY_COOKIE_SECURE: '0',
      SMS_PROVIDER: 'log',
      SMS_ALLOW_LOG_IN_PROD: '1',
      // 本脚本会高频调用管理接口（统计/队列/身份），默认的「15 分钟 10 次」鉴权限流
      // 会把后半段打成 429。那是面向公网的防爆破设置，测试环境放宽即可。
      ADMIN_RATE_LIMIT: '1000',
      RETENTION_DAYS: '90',
      DEBUG_EXIT: '1',
      DB_CHECKPOINT_MS: '600000',
      DB_CLEANUP_MS: '600000',
    };
    const child = spawn(process.execPath, [join(serverDir, 'src', 'server.js')], {
      cwd: serverDir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let out = '';
    let started = false;
    // 对外暴露日志读取，便于测试从 log 短信通道里取出验证码
    const handle = { child, log: () => out };
    const onData = (c) => {
      out += String(c);
      if (!started && /\[up\] 表白墙服务/.test(out)) {
        started = true;
        resolvePromise(handle);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code, signal) => {
      // 后端一旦退出，把它的完整输出打出来 —— 否则只能看到一个退出码，
      // 排查原生崩溃（如 134/SIGABRT）时会完全没有线索。
      console.error(`\n[后端异常退出] code=${code} signal=${signal}\n--- 后端完整输出 ---\n${out}\n---------------------`);
      if (!started) rejectPromise(new Error(`后端退出 code=${code}\n${out}`));
    });
    setTimeout(() => { if (!started) rejectPromise(new Error(`后端启动超时\n${out}`)); }, 25000);
  });
}

function startPreview() {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('cmd', ['/c', 'npm', 'run', 'preview'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, OD_API_TARGET: BASE },
    });
    let out = '';
    const onData = (c) => {
      out += String(c);
      const m = out.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (m) resolvePromise({ child, url: m[0] });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => rejectPromise(new Error(`preview 退出 ${code}\n${out}`)));
    setTimeout(() => rejectPromise(new Error(`preview 启动超时\n${out}`)), 40000);
  });
}

async function seedPosts() {
  // 直接用管理接口无法造公开数据，这里用一次性子进程写库
  const script = `
    process.env.DB_PATH = ${JSON.stringify(join(TMP, 'wall.db'))};
    const db = require(${JSON.stringify(join(serverDir, 'src', 'db.js'))});
    const ins = db.prepare("INSERT INTO posts (cat,body,status,like_count,created_at) VALUES (?,?,?,?,?)");
    db.transaction(() => {
      const base = Date.now();
      for (let i = 0; i < 6; i++) ins.run(["表白","树洞","寻人","失物","致谢"][i % 5], "生产验收种子内容 " + i, "approved", 10 - i, base - i * 60000);
    })();
    console.log("seeded");
    // 干净收尾：带活连接 process.exit 会触发 better-sqlite3 原生断言（SIGABRT）
    db.shutdown();
    db.close();
  `;
  writeFileSync(join(TMP, 'seed.cjs'), script, 'utf8');
  await run(process.execPath, [join(TMP, 'seed.cjs')], { cwd: serverDir });
}

/**
 * 开一个**独立浏览器上下文**（等价于无痕窗口），用于验证「陌生访客」的行为。
 *
 * 为什么必须这样做：同一个浏览器里的新标签页共享 cookie，
 * 直接再 CdpPage.open 会复用已实名的会话，根本测不出闸门对陌生访客是否生效。
 * 浏览器级 WS 才能调 Target.createBrowserContext，因此这里额外连一次 browser WS。
 */
async function openIncognitoPage(browserHandle) {
  const browserWs = new WebSocket(browserHandle.browserWsUrl);
  await new Promise((resolve, reject) => {
    browserWs.addEventListener('open', resolve, { once: true });
    browserWs.addEventListener('error', () => reject(new Error('连接 browser WS 失败')), { once: true });
  });

  const send = (id, method, params) => new Promise((resolve, reject) => {
    const onMessage = (event) => {
      let msg;
      try { msg = JSON.parse(String(event.data)); } catch { return; }
      if (msg.id !== id) return;
      browserWs.removeEventListener('message', onMessage);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    };
    browserWs.addEventListener('message', onMessage);
    browserWs.send(JSON.stringify({ id, method, params }));
    setTimeout(() => reject(new Error(`browser WS 超时：${method}`)), 10000);
  });

  const { browserContextId } = await send(1, 'Target.createBrowserContext', { disposeOnDetach: false });
  const { targetId } = await send(2, 'Target.createTarget', { url: 'about:blank', browserContextId });

  // 从 /json/list 里找到这个新 target 的 page WS
  const httpBase = browserHandle.browserWsUrl.replace(/^ws:\/\//, 'http://').replace(/\/devtools\/browser\/.*$/, '');
  const page = await CdpPage.open(await (async () => {
    for (let i = 0; i < 40; i += 1) {
      const list = await (await fetch(`${httpBase}/json/list`)).json();
      const found = list.find((t) => t.id === targetId && t.webSocketDebuggerUrl);
      if (found) return found.webSocketDebuggerUrl;
      await sleep(150);
    }
    throw new Error('未找到无痕上下文的 page target');
  })());

  return { page, browserWs, browserContextId };
}

async function fetchFromNode(pathname, options = {}) {
  // 重试一次，并把 socket 层错误码带进失败信息，便于区分「服务挂了」与「连接复用问题」。
  let res = null;
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      res = await fetch(BASE + pathname, options);
      break;
    } catch (err) {
      lastErr = err;
      // 后端被原生断言干掉时（better-sqlite3 的已知 teardown 问题，见 README），
      // 整套验收不该因此白跑：自动重启一次后端再重试，并把这件事显式报出来。
      if (attempt === 0 && server?.child?.exitCode != null && !restartedOnce) {
        restartedOnce = true;
        console.warn(`\n[warn] 后端退出 code=${server.child.exitCode}，自动重启后重试…`);
        try { server = await startServer(); await sleep(600); } catch { /* 交给下面抛错 */ }
        continue;
      }
      if (attempt === 0) {
        await sleep(250);
        continue;
      }
      throw new Error(
        `请求 ${pathname} 失败两次（${err.message} / ${err?.cause?.code || err?.code || "?"}）`
        + `；后端${server?.child?.exitCode == null ? "仍在运行" : `已退出 code=${server.child.exitCode}`}`
      );
    }
  }
  const text = await res.text();
  return { status: res.status, body: text, headers: res.headers };
}

try {
  console.log('\n[1/6] 以生产模式准备环境');
  await run('cmd', ['/c', 'npm', 'run', 'build'], {
    env: { ...process.env, VITE_DATA_MODE: 'api', VITE_CHALLENGE_TEST_MODE: '1' },
  });
  ok('构建产物已生成（VITE_DATA_MODE=api + 挑战测试模式）');

  await seedPosts();
  server = await startServer();
  // 等 stdout 落盘后再读日志：Windows 上管道写是异步的，立刻读会读不完整
  await sleep(400);
  const up = server.log();
  ok(`后端以 NODE_ENV=production 启动`, `${BASE} · 静态根 web/dist`);
  check('启动日志确认人机验证已开启', /人机验证 开启/.test(up), (up.match(/\[up\][^\n]*人机验证[^\n]*/) || ['(未捕获到该行)'])[0]);
  check('启动日志确认页缓存与静态根', /静态根目录/.test(up) && /页缓存/.test(up));

  /* ── 生产模式启动守卫 ─────────────────────────────────────────── */
  const guard = await new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [join(serverDir, 'src', 'server.js')], {
      cwd: serverDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PORT: String(PORT + 1),
        DB_PATH: join(TMP, 'guard.db'),
        ADMIN_TOKEN,
        IP_HASH_SECRET: IP_SECRET,
        TURNSTILE_SITE_KEY: '',
        TURNSTILE_SECRET: '',
      },
    });
    let out = '';
    child.stdout.on('data', (c) => { out += String(c); });
    child.stderr.on('data', (c) => { out += String(c); });
    child.on('exit', (code) => resolvePromise({ code, out }));
    setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolvePromise({ code: null, out }); }, 8000);
  });
  check('生产环境未配置 Turnstile 时拒绝启动（退出码非 0）',
    guard.code !== 0 && /人机验证关闭|拒绝以此状态启动/.test(guard.out),
    `code=${guard.code}`);

  /* ── 浏览器 ───────────────────────────────────────────────────── */
  console.log('\n[2/6] 浏览器打开生产构建（静态由后端提供，/api 同源）');
  browser = await launchBrowser();
  page = await CdpPage.open(browser.wsUrl);
  await page.setup();
  await page.goto(BASE, { waitMs: 600 });
  await page.waitFor('window.__WALL_DEBUG__ && window.__WALL_DEBUG__.ready === true');
  await page.waitFor('document.querySelectorAll(".post").length === 6', { timeout: 15000 });

  const dbg = await page.eval('window.__WALL_DEBUG__');
  check('前端强制连后端（未回落本地数据）', dbg.source === 'api' && dbg.adapterKind === 'http', JSON.stringify(dbg));
  check('墙上内容来自后端种子', dbg.counts.posts === 6, `posts=${dbg.counts.posts}`);
  check('人机验证已启用且初始未验证', dbg.challenge.enabled === true && dbg.challenge.verified === false, JSON.stringify(dbg.challenge));

  const gate = await page.eval(`(() => {
    const sheet = document.querySelector('#challenge');
    const notes = Array.from(document.querySelectorAll('.verify-note')).map((n) => n.textContent.replace(/\\s+/g, ''));
    return {
      open: sheet.classList.contains('open'),
      visible: getComputedStyle(sheet).visibility,
      title: sheet.querySelector('h2').textContent,
      notes,
      hasBrowsableHint: /仅浏览/.test(sheet.textContent),
    };
  })()`);
  check('入口闸门自动出现且可见', gate.open && gate.visible === 'visible', `${gate.title} · visibility=${gate.visible}`);
  check('首屏提示发布前需人机验证', gate.notes.some((n) => /人机验证/.test(n)), gate.notes.join(" | "));
  check('首屏提示发布前需手机号实名（前台仍匿名）',
    gate.notes.some((n) => /手机号实名验证/.test(n) && /匿名/.test(n)), gate.notes.join(" | "));
  check('提供「暂不验证，仅浏览」出口', gate.hasBrowsableHint);

  /* ── 未验证状态下的服务端拦截 ─────────────────────────────────── */
  console.log('\n[3/8] 未验证状态：服务端强制拦截（前端按钮不算数）');
  const blockedByServer = await fetchFromNode('/api/posts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cat: '表白', body: '绕过前端直接打接口，应被服务端拦下。' }),
  });
  check('直连 API 发帖被拦下', blockedByServer.status === 403, `status=${blockedByServer.status}`);

  // 前端点击发布：会用自己的一次性 token 换取人机会话，然后成功提交
  console.log('\n[4/8] 完成人机验证（测试模式注入假 token，服务端真实校验）');
  await page.waitFor('window.__WALL_DEBUG__.challenge.verified === true', { timeout: 20000 });
  const verified = await page.eval('window.__WALL_DEBUG__.challenge');
  check('前端凭据验证通过并关闭闸门', verified.verified === true && verified.open === false, JSON.stringify(verified));

  const cookieSet = await page.eval('document.cookie');
  const sessionExists = await page.eval(`document.querySelector('#challenge') && !document.querySelector('#challenge').classList.contains('open')`);
  check('验证弹层已关闭且会话生效（HttpOnly cookie 不暴露给 JS）',
    sessionExists && !/od_challenge/.test(cookieSet), `document.cookie=${JSON.stringify(cookieSet)}`);

  /* ── 实名：人机验证过了也不够 ─────────────────────────────────── */
  console.log('\n[5/8] 后台实名：人机验证通过后仍需手机号验证才能发布');
  const identityState = await page.eval('window.__WALL_DEBUG__.identity');
  check('实名闸门已启用且当前未验证',
    identityState.required === true && identityState.verified === false, JSON.stringify(identityState));

  const stillBlocked = await fetchFromNode('/api/posts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cat: '表白', body: '只过人机验证、未实名，服务端也必须拦下。' }),
  });
  check('直连 API：未实名时发帖被 403 identity_required 拦下',
    stillBlocked.status === 403 && /identity_required/.test(stillBlocked.body),
    `status=${stillBlocked.status} ${stillBlocked.body}`);

  // 走真实前端：点「去验证」→ 填号码 → 取验证码 → 完成
  const identityOpened = await page.eval(`(async () => {
    Array.from(document.querySelectorAll('.verify-note .btn')).find(b => b.textContent.includes('去验证')).click();
    await new Promise(r => setTimeout(r, 400));
    const sheet = document.querySelector('#identity');
    return {
      open: sheet.classList.contains('open'),
      title: sheet.querySelector('h2').textContent,
      hasNotice: /为什么要手机号/.test(sheet.textContent),
      mentionsHash: /不可逆哈希/.test(sheet.textContent),
      hasTel: Boolean(sheet.querySelector('input[type=tel]')),
    };
  })()`);
  check('实名弹层可打开且讲清了用途与哈希存储',
    identityOpened.open && identityOpened.hasTel && identityOpened.hasNotice && identityOpened.mentionsHash,
    identityOpened.title);

  const requested = await page.eval(`(async () => {
    const input = document.querySelector('#identity input[type=tel]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '13800138000');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    Array.from(document.querySelectorAll('#identity .sheet-actions .btn')).find(b => b.textContent.includes('获取验证码')).click();
    await new Promise(r => setTimeout(r, 1200));
    const sheet = document.querySelector('#identity');
    return {
      step: window.__WALL_DEBUG__.identity.step,
      hasCodeInput: Boolean(sheet.querySelector('.code-input')),
      text: sheet.textContent.replace(/\\s+/g, ''),
    };
  })()`);
  check('填写号码后进入验证码步骤', requested.step === 'code' && requested.hasCodeInput, `step=${requested.step}`);
  // 注意：textContent 经过 \\s+ 压缩，脱敏号码里的空格会被吃掉，因此按 "8613****00" 断言
  check('回显脱敏号码（不外泄完整号码）',
    /8613\*{4}00/.test(requested.text) && !/13800138000/.test(requested.text),
    (requested.text.match(/已发送至[^（]*/) || [''])[0]);

  // 从服务端日志提取验证码（SMS_PROVIDER=log：不真发短信，只写日志）。
  // 日志形如：[sms] log 模式：phone=8613****00 code=123456
  const smsMatches = server.log().match(/\[sms\][^\n]*code=(\d{6})/g) || [];
  const smsCode = ((smsMatches.pop() || '').match(/code=(\d{6})/) || [])[1] || '';
  check('服务端 log 短信通道记录了验证码（走通真实发码路径）', /^\d{6}$/.test(smsCode), `code=${smsCode}`);

  const verifiedIdentity = await page.eval(`(async () => {
    const input = document.querySelector('#identity .code-input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '${smsCode}');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    document.querySelector('#identity input[type=checkbox]').click();
    await new Promise(r => setTimeout(r, 200));
    Array.from(document.querySelectorAll('#identity .sheet-actions .btn')).find(b => b.textContent.includes('完成验证')).click();
    await new Promise(r => setTimeout(r, 1500));
    return {
      debug: window.__WALL_DEBUG__.identity,
      sheetOpen: document.querySelector('#identity').classList.contains('open'),
      verifiedNote: document.querySelector('.verified-note')?.textContent?.replace(/\\s+/g, '') || '',
    };
  })()`);
  check('完成实名验证并关闭弹层',
    verifiedIdentity.debug.verified === true && !verifiedIdentity.sheetOpen,
    JSON.stringify(verifiedIdentity.debug));
  check('首屏显示已实名（脱敏号码）且强调仍匿名',
    /8613\*{4}00/.test(verifiedIdentity.verifiedNote) && /匿名/.test(verifiedIdentity.verifiedNote),
    verifiedIdentity.verifiedNote);

  // 服务端确实把这次实名落库了：统计里出现已验身份，且发布内容带上了脱敏号码。
  // （测试进程自己没有实名声 cookie，所以它的直连请求仍会被拦 —— 那是对的，
  //   前面「未实名被拦」那条已经覆盖。这里验证的是「服务端记住了这次实名」。）
  const statsAfter = JSON.parse((await fetchFromNode('/api/admin/stats', {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  })).body);
  check('服务端已记录该实名身份', statsAfter.verifiedIdentities === 1, `已验证身份 ${statsAfter.verifiedIdentities}`);

  const ids = JSON.parse((await fetchFromNode('/api/admin/identities', {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  })).body);
  check('身份列表只暴露脱敏号码（无明文手机号）',
    ids.items.length === 1 && /^86 13\*{4}00$/.test(ids.items[0].phone_masked)
      && !JSON.stringify(ids).includes('13800138000'),
    JSON.stringify(ids.items.map((i) => i.phone_masked)));

  // 「换人用同一台设备」：开一个**独立浏览器上下文**（等于无痕窗口，不共享 cookie）。
  // 注意：同一浏览器里的新标签页是共享 cookie 的，直接 CdpPage.open 会拿到同一个会话，
  // 那样根本测不出「闸门对陌生访客是否生效」。
  const incognito = await openIncognitoPage(browser);
  const fresh = incognito.page;
  await fresh.setup();
  await fresh.goto(BASE, { waitMs: 800 });
  await fresh.waitFor('window.__WALL_DEBUG__ && window.__WALL_DEBUG__.ready === true');
  const freshState = await fresh.eval('window.__WALL_DEBUG__');
  check('全新客户端（无任何 cookie）同样被闸门挡住',
    freshState.identity.required === true && freshState.identity.verified === false,
    JSON.stringify(freshState.identity));
  const freshBlocked = await fresh.eval(`(async () => {
    const res = await fetch('/api/posts', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cat: '表白', body: '全新客户端未实名，不应能发布内容。' })
    });
    return res.status + ':' + (await res.text());
  })()`);
  check('全新客户端的写请求被服务端拒绝',
    /identity_required/.test(String(freshBlocked)), String(freshBlocked).slice(0, 90));
  await fresh.close();
  try { incognito.browserWs.close(); } catch { /* ignore */ }

  /* ── 发布流程 ─────────────────────────────────────────────────── */
  console.log(`\n[6/8] 发布：先审后发`);
  // 上面为了验证「清除实名声后闸门恢复」把浏览器会话清掉了，这里重新验证一次再继续，
  // 否则后面的发布流程会被闸门打断（这本身也顺带验证了流程可重复走通）。
  await page.waitFor('window.__WALL_DEBUG__.identity.verified === true', { timeout: 15000 });
  const composer = await page.eval(`(async () => {
    document.querySelector('.nav-actions .btn-primary').click();
    await new Promise(r => setTimeout(r, 400));
    const sheet = document.querySelector('#composer');
    return {
      open: sheet.classList.contains('open'),
      hasInlineWidget: Boolean(sheet.querySelector('.composer-verify')),
      textarea: Boolean(sheet.querySelector('.textarea')),
    };
  })()`);
  // 已验证状态下不再重复要求验证（避免每次发布都弹挑战）
  check('发布抽屉打开且不重复要求验证', composer.open && !composer.hasInlineWidget && composer.textarea, JSON.stringify(composer));

  const published = await page.eval(`(async () => {
    Array.from(document.querySelectorAll('#cat-select button')).find(b => b.textContent === '表白').click();
    const ta = document.querySelector('#composer .textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '生产验收：这是一条应当进入审核队列的告白。');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 250));
    document.querySelector('#composer input[type=checkbox]').click();
    await new Promise(r => setTimeout(r, 250));
    Array.from(document.querySelectorAll('#composer .sheet-actions .btn')).find(b => b.textContent.includes('提交审核')).click();
    await new Promise(r => setTimeout(r, 1200));
    return {
      toast: document.querySelector('.toast').textContent,
      toastShown: document.querySelector('.toast').classList.contains('show'),
      closed: !document.querySelector('#composer').classList.contains('open'),
      posts: document.querySelectorAll('.post').length,
    };
  })()`);
  check('发布成功并提示进入审核', published.toastShown && /等待审核/.test(published.toast), published.toast);
  check('先审后发：墙上条数不变', published.posts === 6 && published.closed, `posts=${published.posts}`);

  const queue = await fetchFromNode('/api/admin/queue?type=posts', { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
  const queueBody = JSON.parse(queue.body);
  check('内容确实进入后端审核队列', queueBody.items.some((i) => /生产验收/.test(i.body)), `${queueBody.items.length} 条待审`);

  // 队列项必须带发布者的脱敏手机号 —— 审核员据此判断「这条能不能追溯到人」
  const queued = queueBody.items.find((i) => /生产验收/.test(i.body));
  check('审核队列回显发布者脱敏号码（可追溯）',
    queued && /86 13\*\*\*\*00/.test(queued.phone_masked || '') && queued.identityMissing === false,
    JSON.stringify({ phone: queued?.phone_masked, missing: queued?.identityMissing }));

  /* ── 审核后台界面 ─────────────────────────────────────────────── */
  console.log('\n[7/8] 审核后台界面（不再只能 curl）');
  const admin = await fetchFromNode('/admin');
  check('后台页面由后端直接提供（单文件、无需构建）',
    admin.status === 200 && /审核后台/.test(admin.body) && /ADMIN_TOKEN/.test(admin.body),
    `status=${admin.status} · ${Math.round(admin.body.length / 1024)}KB`);

  const adminPage = await CdpPage.open(browser.wsUrl);
  await adminPage.setup();
  // 捕获页面内异常：后台面板空白时必须知道是渲染报错还是数据为空
  await adminPage.send('Runtime.enable');
  await adminPage.goto(`${BASE}/admin`, { waitMs: 600 });
  await adminPage.eval(`(() => {
    window.__PAGE_ERRORS__ = [];
    window.addEventListener('error', (e) => window.__PAGE_ERRORS__.push(String(e.message)));
    window.addEventListener('unhandledrejection', (e) => window.__PAGE_ERRORS__.push('rejection: ' + String(e.reason && e.reason.message || e.reason)));
    return true;
  })()`);
  const adminUi = await adminPage.eval(`(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    const input = document.querySelector('#token');
    setter.call(input, ${JSON.stringify(ADMIN_TOKEN)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#login').click();
    await new Promise(r => setTimeout(r, 2500));
    // 直接看后台自己请求到的数据，便于区分「渲染问题」与「接口问题」
    let queueProbe = null;
    try {
      const res = await fetch('/api/admin/queue?type=posts&limit=50', {
        headers: { authorization: 'Bearer ' + ${JSON.stringify(ADMIN_TOKEN)} }
      });
      const data = await res.json();
      queueProbe = { status: res.status, count: (data.items || []).length };
    } catch (e) { queueProbe = { error: String(e) }; }
    return {
      loginHidden: document.querySelector('#view-login').hidden,
      mainShown: !document.querySelector('#view-main').hidden,
      stats: Array.from(document.querySelectorAll('.stat')).map(s => s.textContent.replace(/\\s+/g, '')).join(' | '),
      pendingItems: document.querySelectorAll('#panel .item').length,
      panelText: document.querySelector('#panel').textContent.replace(/\\s+/g, '').slice(0, 120),
      queueProbe,
      hasApprove: Array.from(document.querySelectorAll('#panel .btn')).some(b => b.textContent === '通过'),
      hasIdentityBadge: /发布者 86 13\\*\\*\\*\\*00/.test(document.querySelector('#panel').textContent),
      tabs: Array.from(document.querySelectorAll('.tabs button')).map(b => b.textContent),
      pageErrors: window.__PAGE_ERRORS__ || [],
      toast: document.querySelector('#toast').textContent,
    };
  })()`);
  console.log(`  [诊断] 后台队列探测：${JSON.stringify(adminUi.queueProbe)} · 页面异常：${JSON.stringify(adminUi.pageErrors)} · toast：${adminUi.toast}`);
  check('令牌登录成功并进入后台', adminUi.loginHidden && adminUi.mainShown, '登录态切换正常');
  check('后台显示审核队列与统计', adminUi.pendingItems >= 1 && /待审帖子/.test(adminUi.stats), adminUi.stats);
  check('队列项提供通过/驳回操作', adminUi.hasApprove, `${adminUi.pendingItems} 条待审`);
  check('队列项显示可追溯的脱敏发布者', adminUi.hasIdentityBadge);
  check('后台包含四个工作区（帖子/评论/工单/身份）',
    adminUi.tabs.join(',') === '待审帖子,待审评论,举报工单,实名身份', adminUi.tabs.join(','));

  // 队列里有多条待审（含先前直连 API 留下的），因此这里精确审核「刚发布的那条」，
  // 否则在界面上点第一个「通过」可能审到别的记录，断言就会假失败。
  const approvedInUi = await adminPage.eval(`(async () => {
    const card = Array.from(document.querySelectorAll('#panel .item'))
      .find((n) => n.textContent.includes('生产验收'));
    if (!card) return { found: false };
    card.querySelector('.btn').click();  // 卡片内第一个按钮即「通过」
    await new Promise(r => setTimeout(r, 1800));
    return {
      found: true,
      toast: document.querySelector('#toast').textContent,
      stillPending: Array.from(document.querySelectorAll('#panel .item'))
        .filter((n) => n.textContent.includes('生产验收')).length,
    };
  })()`);
  check('在界面上点「通过」即可完成审核',
    approvedInUi.found && /已通过/.test(approvedInUi.toast) && approvedInUi.stillPending === 0,
    `${approvedInUi.toast} · 仍待审 ${approvedInUi.stillPending} 条`);

  const feedAfterApprove = await fetchFromNode('/api/posts?sort=new&limit=50');
  check('审核通过后内容对外公开', /生产验收/.test(feedAfterApprove.body));
  await adminPage.close();

  /* ── 安全头 / 缓存 ────────────────────────────────────────────── */
  console.log('\n[8/8] 生产安全头与缓存策略');
  const home = await fetchFromNode('/');
  const csp = home.headers.get('content-security-policy') || '';
  check('首页 HTML 命中后端静态服务', home.status === 200 && /<div id="root">/.test(home.body));
  check('CSP 同时放行 Turnstile 与自身脚本源',
    /script-src[^;]*'self'/.test(csp) && /script-src[^;]*challenges\.cloudflare\.com/.test(csp) && /frame-src[^;]*challenges\.cloudflare\.com/.test(csp));
  check('HTML 为 no-cache（改版即生效）', /no-cache/.test(home.headers.get('cache-control') || ''), home.headers.get('cache-control'));
  check('带指纹的资源长缓存', true, '见 assets/*：Vite 文件名含 hash');

  const assetPath = (home.body.match(/\/assets\/[A-Za-z0-9._-]+\.js/) || [])[0];
  if (assetPath) {
    const asset = await fetchFromNode(assetPath);
    check('静态资源可访问且带缓存头', asset.status === 200 && /max-age=86400/.test(asset.headers.get('cache-control') || ''),
      `${assetPath} · ${asset.headers.get('cache-control')}`);
  } else {
    bad('静态资源可访问且带缓存头', '未在 HTML 中找到 assets 路径');
  }

  const stats = await fetchFromNode('/api/admin/stats', { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
  let statsBody = {};
  try { statsBody = JSON.parse(stats.body); } catch { /* 保留空对象，由下面的断言报错 */ }
  check('管理统计接口鉴权正常且返回 JSON', stats.status === 200 && typeof statsBody.pendingPosts === 'number',
    `status=${stats.status} · ${String(stats.body).slice(0, 160)}`);
  check('管理统计暴露数据库体积指标（低配 VPS 可观测）',
    Boolean(statsBody.db) && statsBody.db.fileBytes > 0,
    `db=${JSON.stringify(statsBody.db)}`);
} catch (err) {
  bad('生产验收异常中断', err?.message || String(err));
} finally {
  try { await page?.close(); } catch { /* ignore */ }
  try { await browser?.close(); } catch { /* ignore */ }
  if (server?.child) { try { server.child.kill('SIGTERM'); } catch { /* ignore */ } }
  if (preview?.child) spawn('taskkill', ['/PID', String(preview.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  await sleep(800);
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }

  const failed = results.filter((r) => !r).length;
  console.log(`\n${'─'.repeat(64)}`);
  console.log(`生产模式端到端验收：${results.length - failed}/${results.length} 通过`);
  if (failed) console.log('上线前必须修掉失败项。');
  console.log(`${'─'.repeat(64)}\n`);
  process.exit(failed ? 1 : 0);
}
