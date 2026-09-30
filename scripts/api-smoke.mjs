/**
 * API 模式冒烟测试：验证「react 前端 ↔ server/ 契约」这一侧。
 *
 * 用零依赖的 Node 内置 http 起一个符合 server/ 契约的假后端，
 * 再让 vite preview 的 /api 代理指向它（通过 OD_API_TARGET 环境变量）。
 * 这样即使本机没有编译好的 better-sqlite3，也能端到端验证：
 *   - 探测 /api/health 成功后 source 变成 api（不再回落本地数据）
 *   - 信息流来自后端（数量与内容与本地种子不同）
 *   - 门禁配置明确返回「未启用」→ 前端不弹验证弹层（浏览不受限）
 *   - 发布走 POST /api/posts，返回 pending → 前端提示「等待审核」且不进墙
 *   - 点赞走 POST /api/posts/:id/like，用后端返回的计数覆盖本地乐观值
 *   - 举报走 POST /api/reports，reason 原样带上
 *   - 内测反馈走 POST /api/feedback，cat/body 原样带上
 *
 * 用法：node scripts/api-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpPage, launchBrowser, sleep } from './lib/cdp.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const results = [];
const ok = (name, detail = '') => { results.push(true); console.log(`  \u2713 ${name}${detail ? `  — ${detail}` : ''}`); };
const bad = (name, detail = '') => { results.push(false); console.log(`  \u2717 ${name}${detail ? `  — ${detail}` : ''}`); };
const check = (name, cond, detail = '') => { if (cond) ok(name, detail); else bad(name, detail); return Boolean(cond); };

/* ── 假后端：完全按 server/README.md 与 src/server.js 的响应形状 ─────── */
const seen = { post: null, like: [], report: null, feedback: null };

function startMockApi() {
  const posts = [
    { id: 101, cat: '树洞', body: '来自后端的树洞内容，用于验证 API 模式。', likes: 7, comments: 0, createdAt: Date.now() - 60_000 },
    { id: 102, cat: '寻人', body: '来自后端的寻人内容，用于验证 API 模式。', likes: 3, comments: 1, createdAt: Date.now() - 120_000 },
    { id: 103, cat: '致谢', body: '来自后端的致谢内容，用于验证 API 模式。', likes: 1, comments: 0, createdAt: Date.now() - 180_000 },
  ];

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const json = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
    };
    const readBody = () => new Promise((done) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        try { done(raw ? JSON.parse(raw) : {}); } catch { done({}); }
      });
    });

    (async () => {
      if (req.method === 'GET' && url.pathname === '/api/health') return json(200, { ok: true, now: Date.now() });

      if (req.method === 'GET' && url.pathname === '/api/posts') {
        const cat = url.searchParams.get('cat');
        const list = cat ? posts.filter((p) => p.cat === cat) : posts;
        return json(200, { items: list, nextCursor: null, sort: url.searchParams.get('sort') || 'new' });
      }

      if (req.method === 'GET' && url.pathname === '/api/gate/config') {
        // 内测门禁的显式回应：本假后端不启用门禁，前端据此不弹验证弹层。
        // 真后端在门禁开启时会返回 required=true / verified=false。
        return json(200, {
          enabled: false,
          required: false,
          verified: true,
          inviteRequired: true,
          sessionTtl: 43200,
          challengeTtl: 600,
          challengeItems: 2,
          error: '',
          beta: {
            version: '0.9.0-beta.1',
            name: '内测版',
            notice: '本站处于内测阶段：功能、界面与数据都可能随时调整。',
            feedback: true,
            feedbackEmail: '',
            feedbackMax: 800,
          },
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/posts') {
        seen.post = await readBody();
        return json(201, { id: 999, status: 'pending' });
      }

      const likeMatch = url.pathname.match(/^\/api\/posts\/(\d+)\/like$/);
      if (req.method === 'POST' && likeMatch) {
        const id = Number(likeMatch[1]);
        seen.like.push(id);
        const post = posts.find((p) => p.id === id);
        const liked = seen.like.filter((x) => x === id).length % 2 === 1;
        // 固定返回 4242：可验证前端确实采用了后端权威计数
        return json(200, { liked, likes: 4242 });
      }

      if (req.method === 'POST' && url.pathname === '/api/reports') {
        seen.report = await readBody();
        return json(201, { ok: true });
      }

      if (req.method === 'POST' && url.pathname === '/api/feedback') {
        seen.feedback = await readBody();
        return json(201, { ok: true, id: 1 });
      }

      if (req.method === 'GET' && /^\/api\/posts\/\d+\/comments$/.test(url.pathname)) {
        return json(200, { items: [{ id: 1, body: '来自后端的回复', createdAt: Date.now() }] });
      }

      return json(404, { error: 'not_found' });
    })().catch(() => json(500, { error: 'mock_failure' }));
  });

  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      done({ server, port, url: `http://127.0.0.1:${port}` });
    });
  });
}

function startPreview(apiTarget) {
  return new Promise((done, fail) => {
    const child = spawn('cmd', ['/c', 'npm', 'run', 'preview'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, OD_API_TARGET: apiTarget },
    });
    let out = '';
    const onData = (chunk) => {
      out += String(chunk);
      const match = out.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) done({ child, url: match[0] });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => fail(new Error(`preview 退出 code=${code}\n${out}`)));
    setTimeout(() => fail(new Error(`preview 启动超时\n${out}`)), 40000);
  });
}

let mock = null;
let preview = null;
let browser = null;
let page = null;

try {
  console.log('\n[1/6] 启动假后端 + 预览服务器（/api 代理指向假后端）');
  mock = await startMockApi();
  preview = await startPreview(mock.url);
  ok('假后端与预览服务器就绪', `api=${mock.url} · web=${preview.url}`);

  browser = await launchBrowser();
  page = await CdpPage.open(browser.wsUrl);
  await page.setup();
  await page.goto(preview.url, { waitMs: 400 });
  await page.eval('localStorage.clear()');
  await page.goto(preview.url, { waitMs: 500 });
  await page.waitFor('window.__WALL_DEBUG__ && window.__WALL_DEBUG__.ready === true');
  await page.waitFor('document.querySelectorAll(".post").length === 3', { timeout: 12000 });

  console.log('\n[2/6] 数据源、信息流与门禁状态');
  const dbg = await page.eval('window.__WALL_DEBUG__');
  check('探测到后端后走 API（不再回落本地）', dbg.source === 'api' && dbg.adapterKind === 'http', JSON.stringify(dbg));
  check('信息流来自后端 3 条', dbg.counts.posts === 3, `posts=${dbg.counts.posts}`);
  const feed = await page.eval(`(() => ({
    bodies: Array.from(document.querySelectorAll('.post .post-body')).map(e => e.textContent.slice(0, 6)),
    cats: Array.from(document.querySelectorAll('.post .cat-chip')).map(e => e.textContent),
    likes: Array.from(document.querySelectorAll('.post .act.like .count')).map(e => e.textContent),
    note: document.querySelector('.foot-status .meta').textContent,
  }))()`);
  check('渲染的是后端内容与分类', feed.bodies.every((b) => b.startsWith('来自后端')) && feed.cats.join(',') === '树洞,寻人,致谢', `${feed.cats.join(',')} · ${feed.bodies.join('/')}`);
  check('页脚提示已连接后端 API', /已连接后端 API/.test(feed.note), feed.note);

  // 门禁未启用：既不弹层，也不能挡浏览（本地/静态预览与「后端说不用验证」都是这条路径）
  const gateState = await page.eval(`(() => {
    const el = document.querySelector('#gate');
    return {
      debug: window.__WALL_DEBUG__.gate,
      exists: Boolean(el),
      open: el ? el.classList.contains('open') : false,
      ariaHidden: el ? el.getAttribute('aria-hidden') : null,
      visible: el ? getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none' : false,
    };
  })()`);
  check('门禁未启用时不出现验证弹层',
    gateState.debug.required === false && !gateState.open
      && (!gateState.exists || gateState.ariaHidden === 'true' || !gateState.visible),
    JSON.stringify(gateState));

  console.log('\n[3/6] 点赞：以服务端返回的计数为准');
  await page.eval(`document.querySelector('.post .act.like').click()`);
  await sleep(700);
  const liked = await page.eval(`(() => {
    const b = document.querySelector('.post .act.like');
    return { pressed: b.getAttribute('aria-pressed'), count: b.querySelector('.count').textContent };
  })()`);
  check('点赞请求打到 /api/posts/:id/like', seen.like.length === 1 && seen.like[0] === 101, JSON.stringify(seen.like));
  check('用后端权威计数覆盖乐观值（4242）', liked.pressed === 'true' && liked.count === '4.2k', `${liked.pressed}/${liked.count}`);

  console.log('\n[4/6] 发布：走 POST /api/posts 且保持先审后发');
  const published = await page.eval(`(async () => {
    document.querySelector('.nav-actions .btn-primary').click();
    await new Promise(r => setTimeout(r, 400));
    Array.from(document.querySelectorAll('#cat-select button')).find(b => b.textContent === '表白').click();
    const ta = document.querySelector('#composer .textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '通过 API 提交的一条告白，应该进入审核队列。');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    document.querySelector('#composer input[type=checkbox]').click();
    await new Promise(r => setTimeout(r, 200));
    const before = document.querySelectorAll('.post').length;
    Array.from(document.querySelectorAll('#composer .sheet-actions .btn')).find(b => b.textContent.includes('提交审核')).click();
    await new Promise(r => setTimeout(r, 1000));
    return {
      before,
      after: document.querySelectorAll('.post').length,
      toast: document.querySelector('.toast').textContent,
      modalOpen: document.querySelector('#composer').classList.contains('open'),
    };
  })()`);
  check('请求体包含分类与正文', seen.post && seen.post.cat === '表白' && /审核队列/.test(seen.post.body || ''), JSON.stringify(seen.post));
  check('返回 pending → 提示等待审核并关闭弹层', /等待审核/.test(published.toast) && !published.modalOpen, published.toast);
  check('先审后发：墙上仍是 3 条', published.after === published.before && published.after === 3, `${published.before} → ${published.after}`);

  console.log('\n[5/6] 举报与评论：走真实端点');
  const reported = await page.eval(`(async () => {
    document.querySelector('.post .act.report').click();
    await new Promise(r => setTimeout(r, 400));
    const d = document.querySelector('#report-sheet');
    const openOk = d.classList.contains('open');
    const ta = d.querySelector('.textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '包含了他人真实姓名');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    Array.from(d.querySelectorAll('.sheet-actions .btn')).find(b => b.textContent.includes('提交举报')).click();
    await new Promise(r => setTimeout(r, 700));
    return { openOk, toast: document.querySelector('.toast').textContent };
  })()`);
  check('举报理由提交到 POST /api/reports', seen.report && seen.report.postId === 101 && seen.report.reason === '包含了他人真实姓名', JSON.stringify(seen.report));
  check('举报在 API 模式下弹层正常打开', reported.openOk && /举报已提交/.test(reported.toast), reported.toast);

  const commented = await page.eval(`(async () => {
    const btn = Array.from(document.querySelectorAll('.post .act')).find(b => b.getAttribute('aria-label') === '评论');
    btn.click();
    await new Promise(r => setTimeout(r, 700));
    const txt = Array.from(document.querySelectorAll('.post .comment .txt')).map(e => e.textContent);
    btn.click();
    await new Promise(r => setTimeout(r, 200));
    return { txt, panelClosed: !document.querySelector('.comments') };
  })()`);
  check('评论按需从 /api/posts/:id/comments 拉取', commented.txt.length === 1 && commented.txt[0] === '来自后端的回复', commented.txt.join('/'));

  console.log('\n[6/6] 内测反馈：走 POST /api/feedback');
  const feedback = await page.eval(`(async () => {
    // 入口在顶部内测标识条上（页脚也有一个，选第一个即可）
    const openBtn = Array.from(document.querySelectorAll('[data-od-id="beta-banner"] button'))
      .find((b) => b.textContent.includes('内测反馈'));
    openBtn.click();
    await new Promise(r => setTimeout(r, 400));
    const d = document.querySelector('#feedback');
    const openOk = d.classList.contains('open');
    Array.from(d.querySelectorAll('.cat-select button')).find(b => b.textContent === '改进建议').click();
    const ta = d.querySelector('textarea[data-feedback-body]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '内测反馈：希望分类顺序可以自定义。');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    d.querySelector('[data-feedback-submit]').click();
    await new Promise(r => setTimeout(r, 900));
    return {
      openOk,
      closed: !d.classList.contains('open'),
      toast: document.querySelector('.toast').textContent,
    };
  })()`);
  check('内测反馈提交到 POST /api/feedback（分类与正文原样送达）',
    feedback.openOk && feedback.closed && /反馈已收到/.test(feedback.toast)
      && seen.feedback && seen.feedback.cat === 'idea' && /分类顺序/.test(seen.feedback.body || ''),
    `${JSON.stringify(seen.feedback)} · toast=${feedback.toast}`);
} catch (err) {
  bad('API 模式冒烟测试异常中断', err?.message || String(err));
} finally {
  try { await page?.close(); } catch { /* ignore */ }
  try { await browser?.close(); } catch { /* ignore */ }
  try { mock?.server.close(); } catch { /* ignore */ }
  if (preview) spawn('taskkill', ['/PID', String(preview.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  await sleep(400);
  const failed = results.filter((r) => !r).length;
  console.log(`\n${'─'.repeat(64)}`);
  console.log(`API 模式冒烟测试：${results.length - failed}/${results.length} 通过`);
  console.log(`${'─'.repeat(64)}\n`);
  process.exit(failed ? 1 : 0);
}
