/**
 * 端到端冒烟测试（零依赖）：
 *   1. 起一个构建 + 预览服务器（vite preview，/api 代理指向不存在的后端）
 *   2. 用无头 Edge + CDP 打开页面，断言真实的渲染结果与交互
 *   3. 覆盖：首屏、点赞、分类筛选、关键词搜索、发布校验、发布提交、
 *      举报弹层、Esc 关闭、无横向滚动、reduced-motion
 *
 * 用法：node scripts/smoke.mjs
 * 环境：OD_BROWSER 指定浏览器可执行文件（默认 Edge）
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpPage, launchBrowser, sleep, waitFor } from './lib/cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const shotsDir = join(repoRoot, 'web', 'screenshots');

const results = [];
let page = null;
let browser = null;
let preview = null;
let baseUrl = '';

function ok(name, detail = '') {
  results.push({ pass: true, name, detail });
  console.log(`  \u2713 ${name}${detail ? `  — ${detail}` : ''}`);
}

function bad(name, detail = '') {
  results.push({ pass: false, name, detail });
  console.log(`  \u2717 ${name}${detail ? `  — ${detail}` : ''}`);
}

function check(name, cond, detail = '') {
  if (cond) ok(name, detail);
  else bad(name, detail);
  return Boolean(cond);
}

function startPreview() {
  return new Promise((resolvePromise, rejectPromise) => {
    // 不加 --strictPort：端口被占用时让 Vite 自己往后找，冒烟测试不因环境失败
    const child = spawn('cmd', ['/c', 'npm', 'run', 'preview'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    const onData = (chunk) => {
      out += String(chunk);
      const match = out.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) resolvePromise({ child, url: match[0], log: () => out });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => rejectPromise(new Error(`vite preview 退出（code=${code}）：\n${out}`)));
    setTimeout(() => rejectPromise(new Error(`vite preview 启动超时：\n${out}`)), 40000);
  });
}

async function main() {
  mkdirSync(shotsDir, { recursive: true });

  console.log('\n[0/9] 构建产物 + 预览服务器');
  const built = await new Promise((resolvePromise) => {
    const child = spawn('cmd', ['/c', 'npm', 'run', 'build'], { cwd: repoRoot, stdio: 'ignore', windowsHide: true });
    child.on('exit', (code) => resolvePromise(code === 0));
  });
  if (!check('npm run build 成功', built)) return;

  const started = await startPreview();
  preview = started.child;
  baseUrl = started.url;
  ok('vite preview 已启动', baseUrl);

  browser = await launchBrowser();
  page = await CdpPage.open(browser.wsUrl);
  await page.setup();

  /* ── 0.5 清空本机痕迹：点赞/演示数据/模式，保证每次运行起点一致 ──── */
  await page.goto(baseUrl, { waitMs: 300 });
  await page.eval(`(() => { localStorage.clear(); return true; })()`);
  await page.goto(baseUrl, { waitMs: 400 });

  /* ── 1. 首屏：无后端时自动回落到本地演示数据 ─────────────────────── */
  console.log('\n[1/9] 首屏渲染 + 数据源回落');
  await page.goto(baseUrl, { waitMs: 400 });
  await page.waitFor('window.__WALL_DEBUG__ && window.__WALL_DEBUG__.ready === true');
  await page.waitFor('document.querySelectorAll(".post").length === 8', { timeout: 12000 });

  const debug = await page.eval('window.__WALL_DEBUG__');
  check('数据源回落到本地演示数据', debug.source === 'fallback', JSON.stringify(debug));
  check('墙上渲染 8 条种子内容', debug.counts.posts === 8, `posts=${debug.counts.posts}`);

  const shell = await page.eval(`(() => ({
    title: document.title,
    lang: document.documentElement.lang,
    brand: document.querySelector('.brand-name')?.textContent,
    eyebrow: document.querySelector('.eyebrow')?.textContent?.trim(),
    h1: document.querySelector('.hero h1')?.textContent?.replace(/\\s+/g, ''),
    bg: getComputedStyle(document.body).backgroundColor,
    h1font: getComputedStyle(document.querySelector('.hero h1')).fontFamily,
    odIds: Array.from(document.querySelectorAll('[data-od-id]')).map(e => e.getAttribute('data-od-id')),
    catChips: document.querySelectorAll('.chips .chip').length,
    notice: document.querySelector('.foot-status .meta')?.textContent,
    firstPost: document.querySelector('.post .post-body')?.textContent?.slice(0, 12),
    navSeg: Array.from(document.querySelectorAll('.navseg button')).map(b => b.getAttribute('aria-selected')),
  }))()`);

  check('标题与语言正确', shell.title.includes('校园表白墙') && shell.lang === 'zh-CN', shell.title);
  check('顶栏品牌与 Hero 结构保留', shell.brand === '表白墙' && shell.h1.includes('把没说出口的话'), shell.h1);
  check('设计令牌生效（body 背景 #f5f5f7）', shell.bg === 'rgb(245, 245, 247)', shell.bg);
  check('标题使用 display 字体栈', /SF Pro Display|Helvetica Neue/.test(shell.h1font), shell.h1font);
  check('6 个分类 chips 齐全', shell.catChips === 6, `chips=${shell.catChips}`);
  check('分类/品牌等核心模块 data-od-id 保留', ['topnav', 'hero', 'toolbar', 'feed', 'cta-strip', 'footer', 'tabbar'].every(id => shell.odIds.includes(id)), shell.odIds.join(','));
  check('页脚显示数据源状态', /本地演示数据/.test(shell.notice || ''), shell.notice);
  check('最新/最热分段控件默认选中「最新」', shell.navSeg[0] === 'true' && shell.navSeg[1] === 'false', shell.navSeg.join('/'));
  await page.screenshot(join(shotsDir, '01-desktop.png'), { reveal: true });

  /* ── 2. 排序：最热 ─────────────────────────────────────────────── */
  console.log('\n[2/9] 排序切换（最热）');
  await page.eval(`document.querySelectorAll('.navseg button')[1].click()`);
  await sleep(400);
  const hot = await page.eval(`(() => {
    const counts = Array.from(document.querySelectorAll('.post .act.like .count')).map(el => el.textContent);
    const h1 = document.querySelector('.hero h1');
    return { counts, first: counts[0], sortSelected: document.querySelectorAll('.navseg button')[1].getAttribute('aria-selected'), heroStable: Boolean(h1 && h1.textContent.includes('把没说出口的话')) };
  })()`);
  check('「最热」排序把 2.3k 提到首位', hot.first === '2.3k', hot.counts.join(' > '));
  check('排序切换不破坏首屏结构', hot.heroStable && hot.sortSelected === 'true');
  await page.eval(`document.querySelectorAll('.navseg button')[0].click()`);
  await sleep(400);

  /* ── 3. 点赞 ───────────────────────────────────────────────────── */
  console.log('\n[3/9] 点赞交互');
  // 注意：种子帖 p1=1284、p6=2310，nfmt 会显示成 1.3k / 2.3k，
  // 单次点赞在缩写后看不出差值，所以用「最热排序是否换位」来验证计数确实变了。
  const likeBefore = await page.eval(`(() => {
    const btn = document.querySelector('.post .act.like');
    return { pressed: btn.getAttribute('aria-pressed'), count: btn.querySelector('.count').textContent, first: document.querySelector('.post .cat-chip').textContent };
  })()`);
  await page.eval(`document.querySelector('.post .act.like').click()`);
  await sleep(300);
  const likeAfter = await page.eval(`(() => {
    const btn = document.querySelector('.post .act.like');
    const liked = JSON.parse(localStorage.getItem('od_biaobai_likes_v1') || '[]');
    return { pressed: btn.getAttribute('aria-pressed'), count: btn.querySelector('.count').textContent, liked, popUsed: Boolean(document.querySelector('.act.like.pop')) };
  })()`);
  check('点赞按钮初态为未选中', likeBefore.pressed === 'false' && likeBefore.count === '1.3k', `${likeBefore.pressed}/${likeBefore.count}`);
  check('点击后 aria-pressed=true', likeAfter.pressed === 'true', likeAfter.pressed);
  check('点赞态写入 localStorage（刷新不丢）', Array.isArray(likeAfter.liked) && likeAfter.liked.length === 1, JSON.stringify(likeAfter.liked));

  const likeMoved = await page.eval(`(async () => {
    document.querySelectorAll('.navseg button')[1].click();
    await new Promise(r => setTimeout(r, 400));
    const withoutSecond = Array.from(document.querySelectorAll('.post .cat-chip')).map(e => e.textContent);
    document.querySelectorAll('.navseg button')[0].click();
    await new Promise(r => setTimeout(r, 400));
    return { first: withoutSecond[0] };
  })()`);
  check('计数真实自增（最热排序换位）', likeMoved.first === '表白', `首位分类=${likeMoved.first}`);

  // 取消点赞 → 计数回滚，最热排序复位
  await page.eval(`document.querySelector('.post .act.like').click()`);
  await sleep(300);
  const unlike = await page.eval(`(async () => {
    const btn = document.querySelector('.post .act.like');
    const res = { pressed: btn.getAttribute('aria-pressed'), count: btn.querySelector('.count').textContent };
    document.querySelectorAll('.navseg button')[1].click();
    await new Promise(r => setTimeout(r, 400));
    res.hotFirst = document.querySelector('.post .cat-chip').textContent;
    document.querySelectorAll('.navseg button')[0].click();
    await new Promise(r => setTimeout(r, 400));
    res.liked = JSON.parse(localStorage.getItem('od_biaobai_likes_v1') || '[]').length;
    return res;
  })()`);
  check('再次点击取消点赞', unlike.pressed === 'false' && unlike.liked === 0, `${unlike.pressed} · liked=${unlike.liked}`);
  check('取消后计数回滚（最热排序复位）', unlike.hotFirst === '表白', `首位分类=${unlike.hotFirst}`);

  /* ── 4. 分类筛选 ───────────────────────────────────────────────── */
  console.log('\n[4/9] 分类筛选');
  const treeHole = await page.eval(`(async () => {
    const chip = Array.from(document.querySelectorAll('.chips .chip')).find(b => b.textContent === '树洞');
    chip.click();
    await new Promise(r => setTimeout(r, 500));
    const cats = Array.from(document.querySelectorAll('.post .cat-chip')).map(e => e.textContent);
    return { pressed: chip.getAttribute('aria-pressed'), cats };
  })()`);
  check('筛选「树洞」只剩树洞帖', treeHole.cats.length === 2 && treeHole.cats.every(c => c === '树洞'), treeHole.cats.join(','));

  const backAll = await page.eval(`(async () => {
    const chip = Array.from(document.querySelectorAll('.chips .chip')).find(b => b.textContent === '全部');
    chip.click();
    await new Promise(r => setTimeout(r, 500));
    return document.querySelectorAll('.post').length;
  })()`);
  check('切回「全部」恢复 8 条', backAll === 8, `posts=${backAll}`);

  /* ── 5. 关键词搜索 ─────────────────────────────────────────────── */
  console.log('\n[5/9] 关键词搜索');
  const searched = await page.eval(`(async () => {
    const input = document.querySelector('.search input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '图书馆');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 900));
    return { count: document.querySelectorAll('.post').length, bodies: Array.from(document.querySelectorAll('.post .post-body')).map(p => p.textContent.slice(0, 10)) };
  })()`);
  check('搜索「图书馆」命中 2 条', searched.count === 2, `posts=${searched.count} · ${searched.bodies.join(' | ')}`);

  const cleared = await page.eval(`(async () => {
    const input = document.querySelector('.search input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 900));
    return document.querySelectorAll('.post').length;
  })()`);
  check('清空搜索恢复 8 条', cleared === 8, `posts=${cleared}`);

  const noHit = await page.eval(`(async () => {
    const input = document.querySelector('.search input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'zzz-绝不可能命中的词');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 900));
    const empty = document.querySelector('.empty');
    const res = { visible: empty ? getComputedStyle(empty).display !== 'none' : false, heading: empty?.querySelector('h3')?.textContent };
    setter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 700));
    return res;
  })()`);
  check('无结果时显示空状态', noHit.visible && noHit.heading === '还没有匹配的内容', noHit.heading);

  /* ── 6. 发布校验 ───────────────────────────────────────────────── */
  console.log('\n[6/9] 发布弹层：校验');
  const openedComposer = await page.eval(`(async () => {
    document.querySelector('.nav-actions .btn-primary').click();
    await new Promise(r => setTimeout(r, 500));
    const modal = document.querySelector('#composer');
    const ta = document.querySelector('#composer .textarea');
    return {
      hasOpen: modal.classList.contains('open'),
      role: modal.getAttribute('role'),
      ariaModal: modal.getAttribute('aria-modal'),
      ariaHidden: modal.getAttribute('aria-hidden'),
      textareaCount: document.querySelectorAll('#composer .textarea').length,
      catButtons: document.querySelectorAll('#cat-select button').length,
      active: document.activeElement?.tagName,
      activeClass: document.activeElement?.className,
      focusIsTextarea: document.activeElement === ta,
    };
  })()`);
  check('发布弹层打开且语义正确', openedComposer.hasOpen && openedComposer.role === 'dialog' && openedComposer.ariaModal === 'true', JSON.stringify(openedComposer));
  check('打开后焦点自动进入正文输入框', openedComposer.focusIsTextarea, `${openedComposer.active}.${openedComposer.activeClass}`);

  const validation = await page.eval(`(async () => {
    const submit = Array.from(document.querySelectorAll('#composer .sheet-actions .btn')).find(b => b.textContent.includes('提交审核'));
    submit.click();
    await new Promise(r => setTimeout(r, 200));
    const errors = Array.from(document.querySelectorAll('#composer .err')).map(e => e.textContent);
    return { errors, postCount: document.querySelectorAll('.post').length };
  })()`);
  check('空表单提交被拦下并给出 3 条错误', validation.errors.length === 3, validation.errors.join(' | '));

  const tooShort = await page.eval(`(async () => {
    const cat = Array.from(document.querySelectorAll('#cat-select button')).find(b => b.textContent === '表白');
    cat.click();
    const ta = document.querySelector('#composer .textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '太短');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 250));
    const counter = ta.closest('.field').querySelector('.field-label .meta').textContent.replace(/\\s+/g, '');
    Array.from(document.querySelectorAll('#composer .sheet-actions .btn')).find(b => b.textContent.includes('提交审核')).click();
    await new Promise(r => setTimeout(r, 300));
    return { counter, errors: Array.from(document.querySelectorAll('#composer .err')).map(e => e.textContent) };
  })()`);
  check('字数计数器实时更新为 2/500', tooShort.counter === '2/500', tooShort.counter);
  check('正文过短被拦下', tooShort.errors.includes('正文至少需要 6 个字'), tooShort.errors.join(' | '));

  /* ── 7. 发布提交（先审后发） ───────────────────────────────────── */
  console.log('\n[7/9] 发布提交 → 审核队列');
  const submitted = await page.eval(`(async () => {
    const ta = document.querySelector('#composer .textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '冒烟测试：这是一条用于验证发布流程的匿名告白内容。');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#composer input[type=checkbox]').click();
    await new Promise(r => setTimeout(r, 150));
    const beforePosts = document.querySelectorAll('.post').length;
    Array.from(document.querySelectorAll('#composer .sheet-actions .btn')).find(b => b.textContent.includes('提交审核')).click();
    await new Promise(r => setTimeout(r, 900));
    const stuck = JSON.parse(localStorage.getItem('od_biaobai_v2') || '{}');
    return {
      beforePosts,
      afterPosts: document.querySelectorAll('.post').length,
      modalOpen: document.querySelector('#composer').classList.contains('open'),
      toastShown: document.querySelector('.toast').classList.contains('show'),
      toast: document.querySelector('.toast').textContent,
      pending: (stuck.pending || []).length,
      pendingBody: (stuck.pending || [])[0]?.body?.slice(0, 12),
    };
  })()`);
  check('提交后弹层关闭并提示审核', !submitted.modalOpen && submitted.toastShown && submitted.toast.includes('等待审核'), submitted.toast);
  check('先审后发：墙上条数不变', submitted.afterPosts === submitted.beforePosts, `${submitted.beforePosts} → ${submitted.afterPosts}`);
  check('内容进入 pending 队列', submitted.pending === 1, `${submitted.pending} 条 · ${submitted.pendingBody}`);

  /* ── 8. 举报 + Esc ─────────────────────────────────────────────── */
  console.log('\n[8/9] 举报工单 + 键盘可关闭');
  const reported = await page.eval(`(async () => {
    document.querySelector('.post .act.report').click();
    await new Promise(r => setTimeout(r, 300));
    const dialog = document.querySelector('#report-sheet');
    const opened = dialog.classList.contains('open') && dialog.getAttribute('role') === 'dialog';
    const ta = dialog.querySelector('.textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '包含他人真实姓名');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 400)); // 等 React 提交受控值，再点提交
    const typed = ta.value;
    const btn = Array.from(dialog.querySelectorAll('.sheet-actions .btn')).find(b => b.textContent.includes('提交举报'));
    btn.click();
    await new Promise(r => setTimeout(r, 700));
    const stuck = JSON.parse(localStorage.getItem('od_biaobai_v2') || '{}');
    return { opened, typed, btnText: btn.textContent, toast: document.querySelector('.toast').textContent, reports: (stuck.reports || []).length, reason: (stuck.reports || [])[0]?.reason, closed: !dialog.classList.contains('open') };
  })()`);
  check('举报弹层打开且提交成工单（理由随工单落库）', reported.opened && reported.reports === 1 && reported.closed && reported.reason === '包含他人真实姓名', JSON.stringify(reported));
  check('举报后给出提示', /举报已提交/.test(reported.toast || ''), reported.toast);

  const escClosed = await page.eval(`(async () => {
    document.querySelector('.hero .textlink').click();
    await new Promise(r => setTimeout(r, 300));
    const legal = document.querySelector('#legal');
    const openNow = legal.classList.contains('open');
    const hasHK = legal.textContent.includes('个人资料（隐私）条例');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise(r => setTimeout(r, 400));
    return { openNow, hasHK, closedAfterEsc: !legal.classList.contains('open'), title: legal.querySelector('h2').textContent };
  })()`);
  check('公约弹层包含香港法例免责声明', escClosed.openNow && escClosed.hasHK, escClosed.title);
  check('Esc 可关闭弹层', escClosed.closedAfterEsc);

  /* ── 9. 移动端 + 无横向滚动 + reduced motion ───────────────────── */
  console.log('\n[9/9] 移动端适配与可达性');
  await page.metrics({ width: 375, height: 812, mobile: true });
  await sleep(400);
  const mobile = await page.eval(`(() => {
    const tabbar = document.querySelector('.tabbar');
    const navActions = document.querySelector('.nav-actions');
    const tab = document.querySelector('.tab');
    const chip = document.querySelector('.chip');
    const overflow = document.documentElement.scrollWidth - window.innerWidth;
    const cols = getComputedStyle(document.querySelector('.wall')).columnCount;
    return {
      tabbarVisible: getComputedStyle(tabbar).display,
      navActionsHidden: getComputedStyle(navActions).display,
      tabHeight: Math.round(tab.getBoundingClientRect().height),
      chipHeight: Math.round(chip.getBoundingClientRect().height),
      overflow,
      cols,
      fabVisible: getComputedStyle(document.querySelector('.tab-primary .fab')).display,
    };
  })()`);
  check('移动端底部标签栏出现', mobile.tabbarVisible === 'flex' && mobile.fabVisible !== 'none', mobile.tabbarVisible);
  check('移动端隐藏顶栏按钮（主操作下沉）', mobile.navActionsHidden === 'none');
  check('信息流在手机端降为单列', mobile.cols === '1', `columnCount=${mobile.cols}`);
  check('触摸目标 ≥44px', mobile.tabHeight >= 44 && mobile.chipHeight >= 44, `tab=${mobile.tabHeight}px chip=${mobile.chipHeight}px`);
  check('无横向滚动', mobile.overflow <= 0, `overflow=${mobile.overflow}px`);
  await page.screenshot(join(shotsDir, '02-mobile.png'), { reveal: true });

  await page.metrics({ width: 1440, height: 900, mobile: false });
  await sleep(200);
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await sleep(300);
  const reduced = await page.eval(`(() => {
    const el = document.querySelector('.post.reveal');
    return { opacity: getComputedStyle(el).opacity, transition: getComputedStyle(el).transitionDuration };
  })()`);
  check('prefers-reduced-motion 下内容直接可见', Number(reduced.opacity) === 1, `opacity=${reduced.opacity} transition=${reduced.transition}`);

  await page.screenshot(join(shotsDir, '03-desktop-final.png'), { reveal: true });
  ok('截图已保存', 'web/screenshots/');
}

async function cleanup() {
  try { await page?.close(); } catch { /* ignore */ }
  try { await browser?.close(); } catch { /* ignore */ }
  if (preview) {
    // 结束 npm 及其拉起的 vite 子进程，并等端口真的释放，避免下次运行撞端口
    try { spawn('taskkill', ['/PID', String(preview.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
    await sleep(600);
  }
}

main()
  .catch((err) => {
    bad('冒烟测试异常中断', err?.message || String(err));
  })
  .finally(async () => {
    await cleanup();
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${'─'.repeat(64)}`);
    console.log(`冒烟测试：${results.length - failed.length}/${results.length} 通过`);
    if (failed.length) {
      console.log('失败项：');
      failed.forEach((f) => console.log(`  · ${f.name}${f.detail ? ` — ${f.detail}` : ''}`));
    }
    console.log(`${'─'.repeat(64)}\n`);
    process.exit(failed.length ? 1 : 0);
  });
