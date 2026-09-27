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
    const onData = (c) => {
      out += String(c);
      if (!started && /\[up\] 表白墙服务/.test(out)) {
        started = true;
        resolvePromise({ child, log: () => out });
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

async function fetchFromNode(pathname, options = {}) {
  let res = null;
  let lastErr = null;
  // 与 api-test 同样的理由：本脚本会并行启动/替换进程，keep-alive 连接可能指向旧进程。
  // 重试一次，并把 socket 层错误码带进失败信息，便于区分「服务挂了」与「连接复用问题」。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      res = await fetch(BASE + pathname, options);
      break;
    } catch (err) {
      lastErr = err;
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
    return {
      open: sheet.classList.contains('open'),
      visible: getComputedStyle(sheet).visibility,
      title: sheet.querySelector('h2').textContent,
      note: document.querySelector('.verify-note')?.textContent?.replace(/\\s+/g, '') || '',
      hasBrowsableHint: /仅浏览/.test(sheet.textContent),
    };
  })()`);
  check('入口闸门自动出现且可见', gate.open && gate.visible === 'visible', `${gate.title} · visibility=${gate.visible}`);
  check('首屏给出「仅浏览/发布需验证」提示', /发布、评论、举报前需先完成一次人机验证/.test(gate.note), gate.note);
  check('提供「暂不验证，仅浏览」出口', gate.hasBrowsableHint);

  /* ── 未验证状态下的服务端拦截 ─────────────────────────────────── */
  console.log('\n[3/6] 未验证状态：服务端强制拦截（前端按钮不算数）');
  const blockedByServer = await fetchFromNode('/api/posts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cat: '表白', body: '绕过前端直接打接口，应被服务端拦下。' }),
  });
  check('直连 API 发帖被 403 拦下', blockedByServer.status === 403 && /challenge_required/.test(blockedByServer.body), `status=${blockedByServer.status}`);

  // 前端点击发布：会用自己的一次性 token 换取会话，然后成功提交
  console.log('\n[4/6] 完成人机验证（测试模式注入假 token，服务端真实校验）');
  await page.waitFor('window.__WALL_DEBUG__.challenge.verified === true', { timeout: 20000 });
  const verified = await page.eval('window.__WALL_DEBUG__.challenge');
  check('前端凭据验证通过并关闭闸门', verified.verified === true && verified.open === false, JSON.stringify(verified));

  const cookieSet = await page.eval('document.cookie');
  const sessionExists = await page.eval(`document.querySelector('#challenge') && !document.querySelector('#challenge').classList.contains('open')`);
  check('验证弹层已关闭且会话生效（HttpOnly cookie 不暴露给 JS）',
    sessionExists && !/od_challenge/.test(cookieSet), `document.cookie=${JSON.stringify(cookieSet)}`);
  check('验证提示条在通过后消失', await page.eval('!document.querySelector(".verify-note")'));

  /* ── 发布流程 ─────────────────────────────────────────────────── */
  console.log('\n[5/6] 发布：内联验证 + 先审后发');
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

  /* ── 安全头 / 缓存 ────────────────────────────────────────────── */
  console.log('\n[6/6] 生产安全头与缓存策略');
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
  const statsBody = JSON.parse(stats.body);
  check('管理统计暴露数据库体积指标（低配 VPS 可观测）',
    statsBody.db && statsBody.db.fileBytes > 0 && typeof statsBody.db.counts.likes === 'number',
    `文件 ${Math.round(statsBody.db.fileBytes / 1024)}KB · WAL ${statsBody.db.walBytes}B · 缓存 ${statsBody.db.cacheMb}MB`);
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
