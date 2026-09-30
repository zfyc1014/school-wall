/**
 * 内测版元信息（前端兜底值）。
 *
 * 真值由服务端下发生成（`/api/gate/config` 的 `beta` 字段，见 server/src/beta.js）——
 * 这样运营改公告文案不需要重新构建前端。这里只是「后端不可用时」的兜底：
 * 本地演示模式、纯静态预览、后端还没起来的时候，页脚与公告仍然要有个说法。
 */
export const BETA_FALLBACK = {
  version: '0.9.0-beta.1',
  name: '内测版',
  notice: '本站处于内测阶段：功能、界面与数据都可能随时调整，历史内容可能被定期重置。'
    + '请勿发布真实姓名、联系方式等隐私信息，也不要发布无法承受丢失的重要内容。'
    + '遇到问题或有建议，欢迎通过「内测反馈」告诉我们。',
  feedback: true,
  feedbackEmail: '',
  feedbackMax: 800,
};

/** 合并服务端配置与兜底值，缺字段时用兜底补齐 */
export function mergeBeta(remote) {
  if (!remote || typeof remote !== 'object') return BETA_FALLBACK;
  return {
    version: remote.version || BETA_FALLBACK.version,
    name: remote.name || BETA_FALLBACK.name,
    notice: remote.notice || BETA_FALLBACK.notice,
    feedback: remote.feedback !== false,
    feedbackEmail: remote.feedbackEmail || '',
    feedbackMax: Number(remote.feedbackMax) || BETA_FALLBACK.feedbackMax,
  };
}

/** 反馈分类：与后端 POST /api/feedback 的 cat 白名单一致 */
export const FEEDBACK_CATS = [
  { key: 'bug', label: '功能异常' },
  { key: 'idea', label: '改进建议' },
  { key: 'other', label: '其它' },
];
