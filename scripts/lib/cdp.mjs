/**
 * 极简 CDP（Chrome DevTools Protocol）客户端。
 *
 * 为什么不用 puppeteer/playwright：这里只需要「导航 + 求值 + 截图」三件事，
 * 用一个零依赖的小客户端就够了，不给项目增加几十 MB 的下载与安装脚本。
 *
 * Node 24 自带全局 WebSocket，因此本文件没有任何依赖。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label, fn, { timeout = 15000, interval = 200 } = {}) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(interval);
  }
  throw new Error(`等待超时（${label}）${lastError ? `：${lastError.message}` : ''}`);
}

export async function launchBrowser({ executablePath, headless = true } = {}) {
  const exe = executablePath
    || process.env.OD_BROWSER
    || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

  const userDataDir = mkdtempSync(join(tmpdir(), 'od-cdp-'));
  const args = [
    headless ? '--headless=new' : '--new-window',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-gpu',
    '--hide-scrollbars',
    'about:blank',
  ];

  const child = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });

  const browserWsUrl = await waitFor('读取 DevTools 端口', async () => {
    const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
    return match ? match[1] : null;
  }, { timeout: 20000 });

  // browser 级 WS 不支持 Page/Runtime 域，必须换成 page target 的 WS
  const httpBase = browserWsUrl.replace(/^ws:\/\//, 'http://').replace(/\/devtools\/browser\/.*$/, '');
  let resolvedWsUrl = browserWsUrl;
  try {
    const target = await waitFor('定位 page target', async () => {
      const res = await fetch(`${httpBase}/json/list`);
      const list = await res.json();
      return list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || null;
    }, { timeout: 15000, interval: 250 });
    resolvedWsUrl = target.webSocketDebuggerUrl;
  } catch {
    // 退化：部分版本只在列表里给出非 page target，此时沿用 browser WS
  }

  return {
    process: child,
    wsUrl: resolvedWsUrl,
    browserWsUrl,
    userDataDir,
    async close() {
      try { child.kill(); } catch { /* ignore */ }
      await sleep(300);
      try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

export class CdpPage {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.loadWaiter = null;
    this.ws = null;
  }

  static async open(wsUrl) {
    const page = new CdpPage(wsUrl);
    await page.connect();
    return page;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('DevTools WebSocket 连接失败')));
      ws.addEventListener('message', (event) => {
        let msg;
        try {
          msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
        } catch {
          return;
        }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(msg.error.message || 'CDP 调用失败'));
          else res(msg.result);
          return;
        }
        if (msg.method === 'Page.loadEventFired' && this.loadWaiter) {
          const done = this.loadWaiter;
          this.loadWaiter = null;
          done();
        }
      });
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 20000);
    });
  }

  async setup() {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
    });
  }

  async goto(url, { waitMs = 300 } = {}) {
    const loaded = new Promise((resolve) => { this.loadWaiter = resolve; });
    await this.send('Page.navigate', { url });
    await Promise.race([loaded, sleep(10000)]);
    await sleep(waitMs);
  }

  /** 在页面里求值：表达式字符串，或返回可序列化值的函数 */
  async eval(fnOrExpr) {
    const expression = typeof fnOrExpr === 'function' ? `(${fnOrExpr.toString()})()` : String(fnOrExpr);
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`页面内求值异常：${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`);
    }
    return res.result?.value;
  }

  /** 等页面内条件为真 */
  waitFor(expression, options = {}) {
    return waitFor(String(expression).slice(0, 60), async () => {
      const ok = await this.eval(expression);
      return ok ? ok : null;
    }, options);
  }

  async metrics({ width, height, mobile }) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: Boolean(mobile),
    });
    await sleep(120);
  }

  /**
   * 截图。默认先关掉入场动画：
   * 全页截图会一次性展开整个文档，而 .reveal 依赖 IntersectionObserver
   * 在「进入视口」时才加 .in，首屏之外的卡片会停在 opacity:0，
   * 截出来会是一片空白——那是截图方式的假象，不是渲染问题。
   */
  async screenshot(path, { reveal = false } = {}) {
    if (reveal) {
      await this.eval(`(() => {
        document.querySelectorAll('.reveal').forEach((el) => el.classList.add('in'));
        return true;
      })()`);
      await sleep(600); // 等 520ms 的入场过渡走完
    }
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, Buffer.from(data, 'base64'));
    return path;
  }

  async close() {
    try { this.ws?.close(); } catch { /* ignore */ }
  }
}

export { waitFor, sleep };
