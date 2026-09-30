/**
 * 全站内测标识条（吸顶）。
 *
 * 为什么做成常态可见的一条而不是一次性弹窗：
 *   - 内测版的数据可能被重置、功能可能随时变，用户在任何时候都该看得到这个前提；
 *   - 它同时是「内测说明 / 内测反馈 / 输入邀请码」三个入口的常驻位置，
 *     比藏在页脚更容易被发现，也不打扰阅读（不遮挡内容，只占一条窄带）。
 */
export function BetaBanner({
  beta, gateRequired, gateVerified,
  onOpenNotice, onOpenFeedback, onOpenGate,
}) {
  return (
    <div className="beta-banner" data-od-id="beta-banner" role="status">
      <div className="container beta-banner-inner">
        <span className="beta-tag">{beta.name} {beta.version}</span>
        <span className="beta-text">功能和数据随时会变，别发隐私信息。</span>
        <span className="beta-actions">
          <button className="textlink" type="button" onClick={onOpenNotice}>内测说明</button>
          {beta.feedback && (
            <button className="textlink" type="button" onClick={onOpenFeedback}>内测反馈</button>
          )}
          {gateRequired && !gateVerified && (
            <button className="textlink" type="button" onClick={onOpenGate}>输入邀请码</button>
          )}
        </span>
      </div>
    </div>
  );
}
