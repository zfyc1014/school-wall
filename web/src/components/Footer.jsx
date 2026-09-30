import { IconGrid, IconPlus, IconShield } from './icons.jsx';

/** 页脚：品牌说明 + 平台/法律链接 + 内测信息与数据源状态 */
export function Footer({
  siteName, beta, onOpenComposer, onOpenLegal, onOpenFeedback,
  source, sourceNote, demoReset,
}) {
  const dotClass =
    source === 'api' ? 'dot api' : source === 'fallback' ? 'dot fallback' : 'dot local';

  return (
    <footer className="pagefoot" data-od-id="footer">
      <div className="container">
        <div className="foot-grid">
          <div className="foot-col">
            <div className="row" style={{ marginBottom: 'var(--space-3)' }}>
              <span
                className="brand-mark"
                aria-hidden="true"
                style={{ width: 26, height: 26, fontSize: 14 }}
              >
                墙
              </span>
              <span className="brand-name">{siteName}</span>
              <span className="beta-tag">{beta.name} {beta.version}</span>
            </div>
            <p>校园匿名分享空间。内容均由用户发布，不代表平台或学校立场。</p>
          </div>

          <div className="foot-col">
            <div className="foot-title">平台</div>
            <div className="foot-links">
              <button type="button" onClick={onOpenComposer}>发布告白</button>
              {beta.feedback && (
                <button type="button" onClick={onOpenFeedback}>内测反馈</button>
              )}
              {demoReset && (
                <button type="button" onClick={demoReset}>重置演示数据</button>
              )}
            </div>
          </div>

          <div className="foot-col">
            <div className="foot-title">规则与法律</div>
            <div className="foot-links">
              <button type="button" onClick={onOpenLegal}>免责声明与发布公约</button>
              <button type="button" onClick={onOpenLegal}>举报与下架流程</button>
              <button type="button" onClick={onOpenLegal}>隐私与资料处理说明</button>
            </div>
          </div>
        </div>

        <div className="foot-status">
          <span className={dotClass} aria-hidden="true" />
          <span className="meta">{sourceNote}</span>
        </div>

        <div className="foot-bottom">
          <span>© 2026 校园表白墙 · {beta.name} {beta.version}</span>
          <span>
            内容为用户生成内容（UGC）· 举报邮箱 report@example.edu
            {beta.feedbackEmail ? ` · 反馈邮箱 ${beta.feedbackEmail}` : ''}
          </span>
        </div>
      </div>
    </footer>
  );
}

/** 移动端底部标签栏：表白墙 / 发布（主操作）/ 公约 */
export function TabBar({ onOpenComposer, onOpenLegal }) {
  return (
    <nav className="tabbar" data-od-id="tabbar" aria-label="移动端底部导航">
      <button className="tab" type="button" aria-current="page" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
        <IconGrid width={22} height={22} strokeWidth={1.7} />
        <span>表白墙</span>
      </button>
      <button className="tab tab-primary" type="button" onClick={onOpenComposer} aria-label="发布告白">
        <span className="fab" aria-hidden="true"><IconPlus width={24} height={24} strokeWidth={2} /></span>
        <span>发布</span>
      </button>
      <button className="tab" type="button" onClick={onOpenLegal}>
        <IconShield width={22} height={22} strokeWidth={1.7} />
        <span>公约</span>
      </button>
    </nav>
  );
}
