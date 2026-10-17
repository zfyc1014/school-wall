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
