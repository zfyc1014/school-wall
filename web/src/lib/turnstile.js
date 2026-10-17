/**
 * Cloudflare Turnstile 的脚本加载器（显式渲染模式）。
 *
 * 为什么不直接把 <script src> 写进 index.html：
 *   - 这个 SPA 只在「登录弹层」里需要人机验证，首屏不该为它付一次网络往返；
 *   - 显式渲染（render=explicit）才能拿到 widget id，从而在每次提交后 reset —— 
 *     token 是一次性的，第二次发请求必须换新的。
 *
 * 全站共享同一个加载 Promise：多个弹层/重开弹层都不会重复插 script。
 */

const SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

let loading = null;

export function loadTurnstile() {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (loading) return loading;

  loading = new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = setInterval(() => {
      if (window.turnstile) {
        clearInterval(tick);
        resolve(window.turnstile);
        return;
      }
      // 15 秒还没就绪就当加载失败：多半是网络被挡，或 CSP 没放行
      if (Date.now() - started > 15000) {
        clearInterval(tick);
        loading = null;
        reject(new Error("turnstile 加载超时"));
      }
    }, 100);

    let script = document.querySelector('script[data-turnstile="1"]');
    if (!script) {
      script = document.createElement("script");
      script.src = SRC;
      script.async = true;
      script.defer = true;
      script.dataset.turnstile = "1";
      document.head.appendChild(script);
    }
    script.addEventListener("error", () => {
      clearInterval(tick);
      loading = null;
      reject(new Error("turnstile 脚本加载失败"));
    }, { once: true });
  });

  return loading;
}
/**
 * 把 Turnstile 的错误码翻成人话。
 *
 * 这些码只会出现在 widget 的 error-callback 里，显示成一行数字对运维毫无帮助 ——
 * 尤其 110200，它真正想说的是「你当前访问的域名没登记在这个 sitekey 上」，
 * 和「配置错了/密钥错了」完全是两回事。IP 地址也无法登记，所以用 IP 访问时永远过不了。
 */
const ERROR_TEXT = {
  110200: '当前访问的域名没有登记在这个 sitekey 上（Turnstile → Hostname Management）；用 IP 访问无法通过人机验证',
  110100: 'sitekey 无效（检查 TURNSTILE_SITE_KEY 是否填错）',
  110110: 'action 与 widget 配置不一致（检查 TURNSTILE_ACTION）',
  110500: '当前浏览器不受 Turnstile 支持，请换浏览器或用无痕窗口',
  110600: '域名格式不被接受（Turnstile 只接受域名，不接受 IP 地址）'
};

export function describeTurnstileError(code) {
  const key = Number(code);
  if (ERROR_TEXT[key]) return ERROR_TEXT[key] + '（' + key + '）';
  if (key >= 300000) return '人机验证挑战失败，请刷新重试（' + key + '）';
  return '人机验证出错（错误码 ' + code + '）';
}
