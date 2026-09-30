import { IconClose } from './icons.jsx';

/**
 * 首屏内测公告。
 *
 * 与标识条的分工：标识条是「一直在那儿的标签」，这里是「值得读一遍的说明」——
 * 用户读完后可以关掉，关闭状态记在 localStorage（storage.js 的 BETA_NOTICE_KEY），
 * 刷新与回访都不再打扰；换内测版本号时公告会重新出现（见 shouldShowNotice）。
 */
export function BetaNotice({ beta, visible, onOpenFeedback, onDismiss }) {
  if (!visible || !beta.notice) return null;

  return (
    <section className="beta-notice" id="beta-notice" data-od-id="beta-notice" aria-labelledby="beta-notice-title">
      <div className="beta-notice-head">
        <span className="beta-tag">{beta.name} {beta.version}</span>
        <h2 id="beta-notice-title">这是一次内测</h2>
        <button className="icon-btn" type="button" onClick={onDismiss} aria-label="关闭内测说明">
          <IconClose />
        </button>
      </div>

      <p className="beta-notice-body">{beta.notice}</p>

      <div className="beta-notice-foot">
        <span className="meta">
          内测期间不收手机号，也没有账号。发帖仍然是先审后发。
        </span>
        {beta.feedback && (
          <button className="btn btn-secondary btn-sm" type="button" onClick={onOpenFeedback}>
            提交内测反馈
          </button>
        )}
      </div>
    </section>
  );
}
