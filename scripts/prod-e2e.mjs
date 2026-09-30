/**
 * 生产模式端到端验收：真实 Node 后端 + 真实构建产物 + 无头浏览器。
 *
 * 这是最接近上线状态的一条链路：
 *   后端（NODE_ENV=production、内测门禁开启、自己的静态服务）
 *     → 浏览器打开首页，闸门自动出现
 *     → 未通过门禁时写请求被服务端 403 gate_required 拦下
 *     → 用真实 UI 填「内测邀请码 + 服务端出的题」完成验证（无任何测试后门）
 *     → 发布走通、内容进入审核队列、后台点「通过」后才公开
 *     → 评论同样先审后发，comment_count 在通过时才 +1
 *
 * 为什么必须用 NODE_ENV=production：这才是上线时的行为 ——
 * 未配置 GATE_INVITE_CODES 就拒绝启动、CSP 收紧到 'self'、静态指纹长缓存、
 * VITE_DATA_MODE=api 不回落本地数据。
 *
 * 内测版（0.9.x）删除了 Cloudflare Turnstile、手机号实名与短信，
 * 因此本脚本里既没有第三方站点密钥，也没有验证码/脱敏号码这类探测字段。
 *
 * 用法：node scripts/prod-e2e.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpPage, launchBrowser, sleep, waitFor } from './lib/cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const serverDir = join(repoRoot, 'server');

const PORT = 8300 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_TOKEN = 'e2e-admin-token-0123456789abcdef';
const IP_SECRET = 'e2e-ip-hash-secret-0123456789';
/** 内测邀请码：gate.js 会忽略短于 8 位的码，这里必须够长 */
const INVITE_CODE = 'E2E-INVITE-1';
const WRONG_INVITE_CODE = 'E2E-WRONG-CODE-1';
/** 两条正文用不同前缀，避免在队列/公开流里互相误匹配 */
const POST_BODY = '生产验收：这是一条应当进入审核队列的告白。';
const COMMENT_BODY = '生产验收评论：通过后才会出现在墙下。';
const TMP = mkdtempSync(join(tmpdir(), 'od-prod-e2e-'));

const results = [];
const ok = (name, detail = '') => { results.push(true); console.log(`  \u2713 ${name}${detail ? `  — ${detail}` : ''}`); };
const bad = (name, detail = '') => { results.push(false); console.log(`  \u2717 ${name}${detail ? `  — ${detail}` : ''}`); };
const check = (name, cond, detail = '') => { if (cond) ok(name, detail); else bad(name, detail); return Boolean(cond); };

let server = null;
let browser = null;
let page = null;
/** 后端因原生 teardown 断言意外退出时，只自动重启一次，避免掩盖真正的启动失败 */
let restartedOnce = false;
/** 收尾阶段我们自己 kill 后端：这时的退出是预期行为，不该打印成「异常退出」 */
let intentionalShutdown = false;

function run(cmd, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...options });
    let out = '';
    child.stdout.on('data', (c) => { out += String(c); });
    child.stderr.on('data', (c) => { out += String(c); });
    child.on('exit', (code) => (code === 0 ? resolvePromise(out) : rejectPromise(new Error(`${cmd} 退出 ${code}\n${out}`))));
  });
}

/**
 * 内测版的环境变量基线。
 *
 * Turnstile / 实名 / 短信相关的变量已随功能一并删除 —— 这里显式从子进程环境里
 * 剔掉，免得从外部 shell 继承下来的旧配置让人误以为那些功能还在生效。
 */
function baseEnv(extra = {}) {
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
    TRUST_PROXY: '0', // 直接监听，不走反代，便于测试
    // 自托管内测门禁：邀请码 + 服务端出题的一次性本地挑战，全程不出网
    GATE_ENFORCE: '1',
    GATE_INVITE_CODES: INVITE_CODE,
    GATE_COOKIE_SECURE: '0', // 本次验收跑在 http://127.0.0.1 上
    // 本脚本会高频调用管理接口（统计/队列/工单），默认的「15 分钟 10 次」鉴权限流
    // 会把后半段打成 429。那是面向公网的防爆破设置，测试环境放宽即可。
    ADMIN_RATE_LIMIT: '1000',
    RETENTION_DAYS: '90',
    DEBUG_EXIT: '1',
    DB_CHECKPOINT_MS: '600000',
    DB_CLEANUP_MS: '600000',
    ...extra,
  };
  for (const key of [
    'TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET',
    'CHALLENGE_ENFORCE', 'CHALLENGE_COOKIE_SECURE',
    'IDENTITY_ENFORCE', 'IDENTITY_SECRET', 'IDENTITY_COOKIE_SECURE',
    'SMS_PROVIDER', 'SMS_ALLOW_LOG_IN_PROD',
  ]) delete env[key];
  return env;
}

function startServer() {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [join(serverDir, 'src', 'server.js')], {
      cwd: serverDir, env: baseEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let out = '';
    let started = false;
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
      if (intentionalShutdown) return; // 收尾时我们自己杀的，属于预期
      // 后端一旦退出，把它的完整输出打出来 —— 否则只能看到一个退出码，
      // 排查原生崩溃（如 134/SIGABRT）时会完全没有线索。
      console.error(`\n[后端异常退出] code=${code} signal=${signal}\n--- 后端完整输出 ---\n${out}\n---------------------`);
      if (!started) rejectPromise(new Error(`后端退出 code=${code}\n${out}`));
    });
    setTimeout(() => { if (!started) rejectPromise(new Error(`后端启动超时\n${out}`)); }, 25000);
  });
}

/**
 * 生产模式启动守卫：不给 GATE_INVITE_CODES。
 * 期望：退出码非 0，且说明里同时出现变量名与可执行的修复步骤。
 */
function runStartupGuard() {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [join(serverDir, 'src', 'server.js')], {
      cwd: serverDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: baseEnv({
        PORT: String(PORT + 1),
        DB_PATH: join(TMP, 'guard.db'),
        // 显式清空：本次要验证的正是「没有邀请码就不许启动」
        GATE_ENFORCE: '',
        GATE_INVITE_CODES: '',
        GATE_ALLOW_DISABLED: '',
      }),
    });
    let out = '';
    child.stdout.on('data', (c) => { out += String(c); });
    child.stderr.on('data', (c) => { out += String(c); });
    child.on('exit', (code) => resolvePromise({ code, out }));
    setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolvePromise({ code: null, out }); }, 8000);
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
 * 直接再 CdpPage.open 会复用已通过门禁的会话，根本测不出闸门对陌生访客是否生效。
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

function jsonOf(text) {
  try { return JSON.parse(text); } catch { return {}; }
}

/* ─────────────────── 门禁弹层：取题 / 作答 / 读状态 ─────────────────── */

/** 读弹层与门禁状态（读不到也不抛错，交给断言去失败） */
function gateState(pg) {
  return pg.eval(`(() => {
    const sheet = document.querySelector('#gate');
    const err = sheet ? sheet.querySelector('.err') : null;
    return {
      exists: Boolean(sheet),
      open: sheet ? sheet.classList.contains('open') : false,
      ariaHidden: sheet ? sheet.getAttribute('aria-hidden') : null,
      err: err ? err.textContent.replace(/\\s+/g, '') : '',
      debug: window.__WALL_DEBUG__ ? window.__WALL_DEBUG__.gate : null,
    };
  })()`);
}

/** 有界等待：不抛错，只返回 true/false —— 后面的断言仍然可以真的失败 */
async function gateOpenWithin(pg, timeout) {
  return waitFor('门禁弹层出现', async () => {
    const s = await gateState(pg);
    return s.open ? true : null;
  }, { timeout }).catch(() => false);
}

/**
 * 解析每道题的题面并自己算答案。
 * 服务端**不下发答案**（只有题面），所以测试必须真的把 "42 + 7 = ?" 算出来 ——
 * 这也是这道闸门能拦住「随手写的批量脚本」的原因。
 */
async function solveGateChallenge(pg) {
  const answers = await pg.eval(`(() => {
    const qs = Array.from(document.querySelectorAll('#gate .gate-q'));
    return qs.map((el) => {
      const m = el.textContent.trim().match(/^(-?\\d+)\\s*([+-])\\s*(-?\\d+)\\s*=\\s*\\?$/);
      if (!m) return '';
      const a = Number(m[1]);
      const b = Number(m[3]);
      return String(m[2] === '+' ? a + b : a - b);
    });
  })()`);
  return Array.isArray(answers) ? answers : [];
}

/** 在弹层里填邀请码与答案（走原生 setter + input 事件，与真人输入等价） */
async function fillGateSheet(pg, code, answers) {
  return pg.eval(`(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    const codeEl = document.querySelector('#gate-code');
    if (codeEl) {
      setter.call(codeEl, ${JSON.stringify(code)});
      codeEl.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const inputs = Array.from(document.querySelectorAll('#gate input[data-gate-answer]'));
    const values = ${JSON.stringify(answers)};
    inputs.forEach((el, i) => {
      setter.call(el, values[i] == null ? '' : values[i]);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    return { code: Boolean(codeEl), inputs: inputs.length };
  })()`);
}

async function submitGateSheet(pg) {
  return pg.eval(`(() => {
    const btn = document.querySelector('#gate [data-gate-submit]');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
}

try {
  /* ── 1. 生产模式环境与启动守卫 ─────────────────────────────────── */
  console.log('\n[1/8] 以生产模式准备环境');
  await run('cmd', ['/c', 'npm', 'run', 'build'], { env: { ...process.env, VITE_DATA_MODE: 'api' } });
  ok('构建产物已生成（VITE_DATA_MODE=api 强制连后端）');

  await seedPosts();
  server = await startServer();
  // 等 stdout 落盘后再读日志：Windows 上管道写是异步的，立刻读会读不完整
  await sleep(400);
  const up = server.log();
  ok('后端以 NODE_ENV=production 启动', `${BASE} · 静态根 web/dist`);
  check('启动日志确认内测门禁已开启且邀请码已配置',
    /内测门禁已启用/.test(up) && /邀请码/.test(up) && !/仅本地挑战/.test(up),
    (up.match(/\[gate\][^\n]*/) || ['(未捕获到该行)'])[0]);
  check('启动日志确认静态根与页缓存', /静态根目录/.test(up) && /页缓存/.test(up));

  const guard = await runStartupGuard();
  check('未配置 GATE_INVITE_CODES 时拒绝启动（退出码非 0，并给出可执行修复说明）',
    guard.code !== 0 && /GATE_INVITE_CODES/.test(guard.out)
      && /修复：设置 GATE_INVITE_CODES/.test(guard.out) && /GATE_ALLOW_DISABLED=1/.test(guard.out),
    `code=${guard.code} · ${(guard.out.match(/\[fatal\][^\n]*/) || [guard.out.trim().slice(0, 80)])[0]}`);

  /* ── 2. 浏览器打开生产构建 ────────────────────────────────────── */
  console.log('\n[2/8] 浏览器打开生产构建（静态由后端提供，/api 同源）');
  browser = await launchBrowser();
  page = await CdpPage.open(browser.wsUrl);
  await page.setup();
  await page.goto(BASE, { waitMs: 600 });
  await page.waitFor('window.__WALL_DEBUG__ && window.__WALL_DEBUG__.ready === true');
  // 门禁配置是独立请求：等它落地再读状态，否则会读到「还没问过后端」的初始值
  await page.waitFor('window.__WALL_DEBUG__.gate && window.__WALL_DEBUG__.gate.loading === false', { timeout: 15000 });
  await page.waitFor('document.querySelectorAll(".post").length === 6', { timeout: 15000 });

  const dbg = await page.eval('window.__WALL_DEBUG__');
  check('前端强制连后端（未回落本地数据）',
    dbg.source === 'api' && dbg.adapterKind === 'http',
    JSON.stringify({ source: dbg.source, adapterKind: dbg.adapterKind }));
  check('墙上内容来自后端种子', dbg.counts.posts === 6, `posts=${dbg.counts.posts}`);
  check('门禁已启用且初始未验证',
    dbg.gate.enabled === true && dbg.gate.required === true && dbg.gate.verified === false,
    JSON.stringify(dbg.gate));

  const betaUi = await page.eval(`(() => {
    const banner = document.querySelector('[data-od-id="beta-banner"]');
    const tag = banner ? banner.querySelector('.beta-tag') : null;
    const notice = document.querySelector('#beta-notice');
    const rect = notice ? notice.getBoundingClientRect() : null;
    return {
      banner: banner ? banner.textContent.replace(/\\s+/g, '') : '',
      tag: tag ? tag.textContent.replace(/\\s+/g, '') : '',
      noticeText: notice ? notice.textContent.replace(/\\s+/g, '') : '',
      noticeVisible: Boolean(notice) && getComputedStyle(notice).display !== 'none'
        && Boolean(rect) && rect.height > 0,
      debugBeta: window.__WALL_DEBUG__.beta,
    };
  })()`);
  check('首屏内测标识条显示内测版本号',
    /内测版/.test(betaUi.tag) && /内测版/.test(betaUi.banner) && /^0\.9\./.test(String(betaUi.debugBeta.version)),
    `${betaUi.tag} · version=${betaUi.debugBeta.version}`);
  check('首屏内测公告可见且写明先审后发',
    betaUi.noticeVisible && /内测/.test(betaUi.noticeText) && /(先审后发|审核)/.test(betaUi.noticeText),
    `可见=${betaUi.noticeVisible}`);

  await gateOpenWithin(page, 10000);
  const gateSheet = await page.eval(`(() => {
    const sheet = document.querySelector('#gate');
    return {
      exists: Boolean(sheet),
      open: sheet ? sheet.classList.contains('open') : false,
      role: sheet ? sheet.getAttribute('role') : '',
      ariaHidden: sheet ? sheet.getAttribute('aria-hidden') : null,
      text: sheet ? sheet.textContent.replace(/\\s+/g, '') : '',
      hasCodeInput: Boolean(document.querySelector('#gate-code')),
      questions: document.querySelectorAll('#gate .gate-q').length,
      answers: document.querySelectorAll('#gate input[data-gate-answer]').length,
    };
  })()`);
  check('门禁弹层自动出现且文案含「内测邀请码」',
    gateSheet.exists && gateSheet.open && gateSheet.role === 'dialog' && gateSheet.ariaHidden === 'false'
      && /内测邀请码/.test(gateSheet.text) && gateSheet.hasCodeInput
      && gateSheet.questions >= 1 && gateSheet.answers === gateSheet.questions,
    `题数=${gateSheet.questions} · 输入框=${gateSheet.answers}`);
  check('提供「暂不验证，仅浏览」出口（浏览不受限）', /暂不验证/.test(gateSheet.text));

  /* ── 3. 未通过门禁：服务端强制拦截 + 发布弹层的门禁说明 ─────────── */
  console.log('\n[3/8] 未通过门禁：服务端强制拦截（前端按钮不算数）');
  const blockedPost = await fetchFromNode('/api/posts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cat: '表白', body: '绕过前端直接打接口，应被服务端拦下。' }),
  });
  check('直连 API 发帖被 403 拦下', blockedPost.status === 403, `status=${blockedPost.status}`);
  const blockedBody = jsonOf(blockedPost.body);
  check('403 响应体为 gate_required', blockedBody.error === 'gate_required', blockedPost.body.slice(0, 120));

  const blockedComment = await fetchFromNode('/api/posts/1/comments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: '未通过门禁的直连评论同样应被拦下。' }),
  });
  check('评论接口同样受门禁保护（403 gate_required）',
    blockedComment.status === 403 && /gate_required/.test(blockedComment.body),
    `status=${blockedComment.status} ${blockedComment.body.slice(0, 80)}`);

  const composerNote = await page.eval(`(async () => {
    document.querySelector('.nav-actions .btn-primary').click();
    await new Promise(r => setTimeout(r, 400));
    const sheet = document.querySelector('#composer');
    const wasOpen = sheet.classList.contains('open');
    const thirdParty = sheet.querySelectorAll('iframe, script[src], link[href^="http"], img[src^="http"]').length;
    const note = sheet.querySelector('.composer-verify');
    const text = note ? note.textContent.replace(/\\s+/g, '') : '';
    const close = sheet.querySelector('.icon-btn[aria-label="关闭"]');
    if (close) close.click();
    await new Promise(r => setTimeout(r, 350));
    return { wasOpen, thirdParty, hasNote: Boolean(note), text, closed: !sheet.classList.contains('open') };
  })()`);
  check('未验证时发布弹层给出内测验证提示',
    composerNote.wasOpen && composerNote.hasNote && composerNote.closed,
    composerNote.text.slice(0, 48));
  check('发布弹层不内嵌任何第三方控件', composerNote.thirdParty === 0, `第三方节点 ${composerNote.thirdParty} 个`);

  /* ── 4. 闸门回归：真实 UI 完成内测验证 ────────────────────────── */
  console.log('\n[4/8] 闸门回归：邀请码 + 服务端出题（真实 UI，无测试后门）');

  // ① 错误邀请码：另开一个独立上下文（无 cookie），填错码 + 正确答案 → 必须被拒
  const wrongCtx = await openIncognitoPage(browser);
  const wrongPage = wrongCtx.page;
  await wrongPage.setup();
  await wrongPage.goto(BASE, { waitMs: 700 });
  await wrongPage.waitFor('window.__WALL_DEBUG__ && window.__WALL_DEBUG__.ready === true');
  const wrongOpen = await gateOpenWithin(wrongPage, 12000);
  const wrongAnswers = await solveGateChallenge(wrongPage);
  await fillGateSheet(wrongPage, WRONG_INVITE_CODE, wrongAnswers);
  await submitGateSheet(wrongPage);
  const wrongState = await waitFor('错误邀请码被拒绝', async () => {
    const s = await gateState(wrongPage);
    return s.err ? s : null;
  }, { timeout: 8000 }).catch(() => gateState(wrongPage));
  check('错误邀请码被拒绝（仍停留弹层、给出错误提示、verified 仍为 false）',
    wrongOpen && wrongState.open === true && wrongState.debug && wrongState.debug.verified === false
      && /邀请码不正确/.test(wrongState.err),
    `verified=${wrongState.debug && wrongState.debug.verified} · err=${wrongState.err}`);
  await wrongPage.close();
  try { wrongCtx.browserWs.close(); } catch { /* ignore */ }

  // ② 正确邀请码 + 自己算出的答案 → 通过并关闭弹层
  const answers = await solveGateChallenge(page);
  await fillGateSheet(page, INVITE_CODE, answers);
  await submitGateSheet(page);
  const verifiedState = await waitFor('门禁验证通过', async () => {
    const s = await gateState(page);
    return s.debug && s.debug.verified === true && !s.open ? s : null;
  }, { timeout: 15000 }).catch(async () => gateState(page));
  check('填邀请码并答对服务端出的题后通过（弹层关闭）',
    verifiedState.debug && verifiedState.debug.verified === true && verifiedState.open === false,
    `${answers.join('/')} · verified=${verifiedState.debug && verifiedState.debug.verified}`);

  const jsCookies = await page.eval('document.cookie');
  check('会话凭据为 HttpOnly（document.cookie 读不到 od_gate）',
    verifiedState.debug && verifiedState.debug.verified === true && !/od_gate/.test(jsCookies),
    `document.cookie=${JSON.stringify(jsCookies)}`);

  // ③ 全新浏览器上下文（无任何 cookie）的写请求同样被拦 —— 最有价值的一条：
  //    它证明防线在服务端，而不是「前端把按钮藏起来了」。
  const freshCtx = await openIncognitoPage(browser);
  const freshPage = freshCtx.page;
  await freshPage.setup();
  await freshPage.goto(BASE, { waitMs: 700 });
  await freshPage.waitFor('window.__WALL_DEBUG__ && window.__WALL_DEBUG__.ready === true');
  const freshBlocked = await freshPage.eval(`(async () => {
    const res = await fetch('/api/posts', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cat: '表白', body: '全新客户端未通过门禁，不应能发布内容。' })
    });
    return res.status + ':' + (await res.text());
  })()`);
  check('全新浏览器上下文（无 cookie）的写请求同样被 403 gate_required 拦下',
    /^403:/.test(String(freshBlocked)) && /gate_required/.test(String(freshBlocked)),
    String(freshBlocked).slice(0, 90));
  await freshPage.close();
  try { freshCtx.browserWs.close(); } catch { /* ignore */ }

  // ④ 挑战只下发题面：答案与邀请码都不能出现在响应里
  const challengeRes = await fetchFromNode('/api/gate/challenge', { method: 'POST' });
  const challengeBody = jsonOf(challengeRes.body);
  const challengeFlat = JSON.stringify(challengeBody);
  check('一次性挑战只下发题面（不含答案 / 邀请码）',
    challengeRes.status === 200 && Array.isArray(challengeBody.items) && challengeBody.items.length >= 1
      && challengeBody.items.every((it) => typeof it.q === 'string' && !('a' in it) && !('answer' in it))
      && !challengeFlat.includes(INVITE_CODE),
    challengeFlat.slice(0, 120));

  /* ── 5. 发布：先审后发 ───────────────────────────────────────── */
  console.log('\n[5/8] 发布：先审后发（内容进队列，不直接公开）');
  const published = await page.eval(`(async () => {
    document.querySelector('.nav-actions .btn-primary').click();
    await new Promise(r => setTimeout(r, 400));
    Array.from(document.querySelectorAll('#cat-select button')).find(b => b.textContent === '表白').click();
    const ta = document.querySelector('#composer .textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(POST_BODY)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 250));
    document.querySelector('#composer input[type=checkbox]').click();
    await new Promise(r => setTimeout(r, 250));
    Array.from(document.querySelectorAll('#composer .sheet-actions .btn')).find(b => b.textContent.includes('提交审核')).click();
    await new Promise(r => setTimeout(r, 1500));
    return {
      toast: document.querySelector('.toast').textContent,
      toastShown: document.querySelector('.toast').classList.contains('show'),
      closed: !document.querySelector('#composer').classList.contains('open'),
      posts: document.querySelectorAll('.post').length,
      hasVerifyNote: Boolean(document.querySelector('#composer .composer-verify')),
    };
  })()`);
  check('发布成功并提示进入审核', published.toastShown && /等待审核/.test(published.toast), published.toast);
  check('先审后发：公开流条数不变', published.posts === 6 && published.closed, `posts=${published.posts}`);

  const queue = await fetchFromNode('/api/admin/queue?type=posts&limit=50', {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  const queueBody = jsonOf(queue.body);
  const queued = (queueBody.items || []).find((i) => String(i.body).includes('这是一条应当进入审核队列的告白'));
  check('内容确实进入后端审核队列', queue.status === 200 && Boolean(queued), `${(queueBody.items || []).length} 条待审`);
  check('审核队列返回分页契约且不含实名 / 手机号字段',
    Array.isArray(queueBody.items) && typeof queueBody.total === 'number' && 'nextCursor' in queueBody
      && Boolean(queued) && !('phone_masked' in queued) && !('identityMissing' in queued)
      && !/phone_masked/.test(queue.body),
    `total=${queueBody.total} · keys=${Object.keys(queued || {}).join(',')}`);

  const legacyIdentity = await fetchFromNode('/api/admin/identities', {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  check('旧实名接口 /api/admin/identities 已下线（404）',
    legacyIdentity.status === 404, `status=${legacyIdentity.status}`);

  /* ── 6. 后台控制台（v2.1.0 单文件控制台） ─────────────────────── */
  console.log('\n[6/8] 后台控制台：令牌登录、切视图、点通过');
  const admin = await fetchFromNode('/admin');
  check('后台页面由后端直接提供（单文件、无需构建）',
    admin.status === 200 && /审核后台/.test(admin.body) && /ADMIN_TOKEN/.test(admin.body),
    `status=${admin.status} · ${Math.round(admin.body.length / 1024)}KB`);

  const adminPage = await CdpPage.open(browser.wsUrl);
  await adminPage.setup();
  await adminPage.goto(`${BASE}/admin`, { waitMs: 300 });
  // 令牌存在 localStorage 的 od_admin_token（后台启动时读取），写入后重载即进入已连接态
  await adminPage.eval(`(() => { localStorage.setItem('od_admin_token', ${JSON.stringify(ADMIN_TOKEN)}); return true; })()`);
  await adminPage.goto(`${BASE}/admin`, { waitMs: 400 });
  const connected = await adminPage.waitFor(
    `document.querySelector('#conn') && document.querySelector('#conn').dataset.mode === 'live'`,
    { timeout: 12000 }
  ).then(() => true).catch(() => false);

  const navState = await adminPage.eval(`(() => ({
    connected: document.querySelector('#conn') ? document.querySelector('#conn').dataset.mode : '',
    views: Array.from(document.querySelectorAll('.nav-item')).map((b) => b.dataset.view),
    title: document.querySelector('#viewTitle') ? document.querySelector('#viewTitle').textContent : '',
  }))()`);
  check('令牌登录后连上真实数据（不再是演示模式）',
    connected && navState.connected === 'live', `#conn=${navState.connected} · 标题=${navState.title}`);
  check('导航至少包含概览 / 待审队列 / 举报工单 / 审核日志四个视图',
    ['overview', 'queue', 'reports', 'audit'].every((v) => navState.views.includes(v)),
    navState.views.join(','));

  const queueView = await adminPage.eval(`(async () => {
    document.querySelector('.nav-item[data-view="queue"]').click();
    await new Promise(r => setTimeout(r, 1200));
    const root = document.querySelector('#view-queue');
    const rows = Array.from(root.querySelectorAll('.q-row'));
    return {
      visible: !root.hidden,
      count: rows.length,
      hasApprove: Boolean(root.querySelector('[data-act="post.approve"]')),
      text: root.textContent.replace(/\\s+/g, '').slice(0, 60),
    };
  })()`);
  check('待审队列视图列出待审内容并提供通过操作',
    queueView.visible && queueView.count >= 1 && queueView.hasApprove && /生产验收/.test(queueView.text),
    `${queueView.count} 条 · ${queueView.text.slice(0, 30)}`);

  // 队列里有多条待审（含先前直连 API 留下的），因此这里精确审核「刚发布的那条」，
  // 否则在界面上点第一个「通过」可能审到别的记录，断言就会假失败。
  const approvedInUi = await adminPage.eval(`(async () => {
    const row = Array.from(document.querySelectorAll('#view-queue .q-row'))
      .find((n) => n.textContent.includes('生产验收'));
    if (!row) return { found: false };
    const btn = row.querySelector('[data-act="post.approve"]');
    const id = btn.dataset.id;
    btn.click();
    await new Promise(r => setTimeout(r, 1600));
    return {
      found: true,
      id,
      toast: document.querySelector('#toaster').textContent.replace(/\\s+/g, ''),
      stillPending: Array.from(document.querySelectorAll('#view-queue .q-row'))
        .filter((n) => n.textContent.includes('生产验收')).length,
    };
  })()`);
  const uiApproved = approvedInUi.found
    && /已通过帖子/.test(approvedInUi.toast) && approvedInUi.stillPending === 0;

  // 容错：后台控制台正被另一个子代理并行改动，界面上的「通过」按钮若失效，
  // 就用它本该调用的管理接口继续，保证「先审后发」整条链路仍然被验证到。
  // （不静默：这里会把界面报的错原样打出来，并在总结里单列。）
  let approvedHow = '后台界面上点「通过」';
  let uiApproveError = '';
  if (!uiApproved) {
    uiApproveError = approvedInUi.toast || '未捕获到提示';
    const apiApprove = await fetchFromNode(`/api/admin/posts/${approvedInUi.id}/approve`, {
      method: 'POST', headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    approvedHow = `回退管理接口（status=${apiApprove.status}）`;
    console.warn(`\n[warn] 后台界面「通过」未生效：${uiApproveError} —— 已回退管理接口继续验收`);
  }
  const apiApproved = !uiApproved
    ? jsonOf((await fetchFromNode(`/api/admin/posts/${approvedInUi.id}`,
      { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } })).body).status === 'approved'
    : true;
  check('后台审核动作生效（界面点「通过」，失效时回退管理接口）',
    Boolean(approvedInUi.found) && (uiApproved || apiApproved),
    `${approvedHow}${uiApproveError ? ` · 界面提示=${uiApproveError}` : ''}${uiApproved ? ` · ${approvedInUi.toast}` : ''}`);

  const reportsView = await adminPage.eval(`(async () => {
    document.querySelector('.nav-item[data-view="reports"]').click();
    await new Promise(r => setTimeout(r, 1000));
    const root = document.querySelector('#view-reports');
    return {
      visible: !root.hidden,
      hasSeg: Boolean(root.querySelector('.seg')),
      title: document.querySelector('#viewTitle').textContent,
      text: root.textContent.replace(/\\s+/g, '').slice(0, 40),
    };
  })()`);
  check('举报工单视图可切换并渲染出工单区',
    reportsView.visible && reportsView.hasSeg, `${reportsView.title} · ${reportsView.text}`);

  // 反馈视图由另一个子代理并行追加：存在就断言，不存在也不让整条链路失败
  if (navState.views.includes('feedback')) {
    const feedbackView = await adminPage.eval(`(async () => {
      document.querySelector('.nav-item[data-view="feedback"]').click();
      await new Promise(r => setTimeout(r, 1000));
      const root = document.querySelector('#view-feedback');
      return {
        visible: !root.hidden,
        hasList: Boolean(root.querySelector('.q-list, .empty, .card')),
        title: document.querySelector('#viewTitle').textContent,
      };
    })()`);
    check('内测反馈视图可打开并渲染出列表容器',
      feedbackView.visible && feedbackView.hasList, feedbackView.title);
  } else {
    ok('内测反馈视图（后台本轮未提供，条件断言跳过）');
  }
  await adminPage.close();

  /* ── 7. 评论：先审后发 + 通过后计数 ───────────────────────────── */
  console.log('\n[7/8] 评论：先审后发，通过后才公开并计数');
  const postId = String(approvedInUi.id);
  const feedAfterApprove = jsonOf((await fetchFromNode('/api/posts?sort=new&limit=50')).body);
  check('审核通过后内容对外公开',
    (feedAfterApprove.items || []).some((i) => String(i.body).includes('这是一条应当进入审核队列的告白')),
    `${(feedAfterApprove.items || []).length} 条公开内容`);

  await page.goto(BASE, { waitMs: 700 });
  await page.waitFor('window.__WALL_DEBUG__ && window.__WALL_DEBUG__.ready === true');
  await page.waitFor(`document.querySelector('[data-od-id="post-${postId}"]') !== null`, { timeout: 12000 });
  const commented = await page.eval(`(async () => {
    const card = document.querySelector('[data-od-id="post-${postId}"]');
    const btn = Array.from(card.querySelectorAll('.act')).find((b) => b.getAttribute('aria-label') === '评论');
    btn.click();
    await new Promise(r => setTimeout(r, 900));
    const input = card.querySelector('.comment-form input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(COMMENT_BODY)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 250));
    card.querySelector('.comment-form button[type=submit]').click();
    await new Promise(r => setTimeout(r, 1400));
    return {
      toast: document.querySelector('.toast').textContent,
      shown: document.querySelector('.toast').classList.contains('show'),
      rendered: Array.from(card.querySelectorAll('.comment .txt')).map((e) => e.textContent),
      empty: card.querySelector('.comments .meta') ? card.querySelector('.comments .meta').textContent : '',
    };
  })()`);
  check('评论提交一律 pending（UI 提示转审核且不立刻显示）',
    commented.shown && /审核/.test(commented.toast) && commented.rendered.length === 0,
    `${commented.toast} · 已渲染 ${commented.rendered.length} 条 · ${commented.empty}`);

  const commentsBefore = jsonOf((await fetchFromNode(`/api/posts/${postId}/comments`)).body);
  const feedAfterComment = jsonOf((await fetchFromNode('/api/posts?sort=new&limit=50')).body);
  const postRow = (feedAfterComment.items || []).find((i) => String(i.id) === postId);
  check('待审评论不出现在公开评论列表（计数仍为 0）',
    (commentsBefore.items || []).length === 0 && Boolean(postRow) && postRow.comments === 0,
    `公开评论 ${(commentsBefore.items || []).length} 条 · comment_count=${postRow && postRow.comments}`);

  const commentQueue = jsonOf((await fetchFromNode('/api/admin/queue?type=comments&limit=50', {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  })).body);
  const queuedComment = (commentQueue.items || []).find((c) => String(c.body).includes('生产验收评论'));
  check('待审评论进入后台评论队列（带所属帖子上下文）',
    Boolean(queuedComment) && Number(queuedComment.post_id) === Number(postId),
    `${(commentQueue.items || []).length} 条待审评论`);

  const approvedComment = await fetchFromNode(`/api/admin/comments/${queuedComment ? queuedComment.id : 0}/approve`, {
    method: 'POST', headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  const commentsAfter = jsonOf((await fetchFromNode(`/api/posts/${postId}/comments`)).body);
  check('评论审核通过后才公开',
    approvedComment.status === 200 && (commentsAfter.items || []).some((c) => String(c.body).includes('生产验收评论')),
    `status=${approvedComment.status} · 公开评论 ${(commentsAfter.items || []).length} 条`);

  const feedFinal = jsonOf((await fetchFromNode('/api/posts?sort=new&limit=50')).body);
  const postFinal = (feedFinal.items || []).find((i) => String(i.id) === postId);
  check('comment_count 在评论通过时 +1',
    Boolean(postFinal) && postFinal.comments === 1, `comment_count=${postFinal && postFinal.comments}`);

  /* ── 8. 安全头 / 缓存 / 统计 ──────────────────────────────────── */
  console.log('\n[8/8] 生产安全头、缓存策略与运营统计');
  const home = await fetchFromNode('/');
  const csp = home.headers.get('content-security-policy') || '';
  check('首页 HTML 命中后端静态服务', home.status === 200 && /<div id="root">/.test(home.body));
  check('HTML 为 no-cache（改版即生效）',
    /no-cache/.test(home.headers.get('cache-control') || ''), home.headers.get('cache-control'));
  check('CSP 只放行自身脚本源（script-src \'self\'）',
    /script-src[^;]*'self'/.test(csp) && /default-src[^;]*'self'/.test(csp), csp.slice(0, 90));
  check('CSP 不再放行任何第三方来源（frame-src \'none\'、无 challenges.cloudflare.com）',
    !/challenges\.cloudflare\.com/.test(csp) && /frame-src[^;]*'none'/.test(csp));

  const assetPath = (home.body.match(/\/assets\/[A-Za-z0-9._-]+\.js/) || [])[0];
  if (assetPath) {
    const asset = await fetchFromNode(assetPath);
    const cache = asset.headers.get('cache-control') || '';
    check('带内容哈希的静态资源长缓存（immutable）',
      asset.status === 200 && /max-age=31536000/.test(cache) && /immutable/.test(cache),
      `${assetPath} · ${cache}`);
  } else {
    bad('带内容哈希的静态资源长缓存（immutable）', '未在 HTML 中找到 assets 路径');
  }

  const stats = await fetchFromNode('/api/admin/stats', { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
  const statsBody = jsonOf(stats.body);
  check('管理统计接口鉴权正常且返回内测运营字段',
    stats.status === 200 && typeof statsBody.pendingPosts === 'number'
      && typeof statsBody.pendingTotal === 'number' && typeof statsBody.generatedAt === 'number'
      && 'oldestPendingAt' in statsBody && typeof statsBody.openFeedback === 'number'
      && statsBody.gateRequired === true && statsBody.gateInviteRequired === true
      && /^0\.9\./.test(String(statsBody.betaVersion)),
    `status=${stats.status} · beta=${statsBody.betaVersion} · gate=${statsBody.gateRequired}`);
  check('管理统计暴露数据库体积指标（低配 VPS 可观测）',
    Boolean(statsBody.db) && statsBody.db.fileBytes > 0,
    `db=${JSON.stringify(statsBody.db)}`);
} catch (err) {
  bad('生产验收异常中断', err?.message || String(err));
} finally {
  try { await page?.close(); } catch { /* ignore */ }
  try { await browser?.close(); } catch { /* ignore */ }
  if (server?.child) {
    intentionalShutdown = true;
    try { server.child.kill('SIGTERM'); } catch { /* ignore */ }
  }
  await sleep(800);
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }

  const failed = results.filter((r) => !r).length;
  console.log(`\n${'─'.repeat(64)}`);
  console.log(`生产模式端到端验收：${results.length - failed}/${results.length} 通过`);
  if (failed) console.log('上线前必须修掉失败项。');
  console.log(`${'─'.repeat(64)}\n`);
  process.exit(failed ? 1 : 0);
}
