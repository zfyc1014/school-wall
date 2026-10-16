import { useState } from 'react';
import { Sheet } from '../components/Sheet.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { IconHeart, IconLink } from '../components/icons.jsx';

/**
 * 支持校园墙（爱发电）。
 *
 * 只有站点配置了 AFDIAN_PAGE 才会走到这里（入口本身也是条件渲染的）。
 *
 * 这里最关键的不是「打钱」，而是**把 uuid 递给用户**：
 * 爱发电的订单不携带付款人邮箱，唯一能把订单和账号连起来的只有下单留言。
 * 所以页面把 uuid 放在最显眼的位置、给一键复制，并说明两种可用的匹配方式
 * （uuid 或注册邮箱）。用户漏填的订单也不会丢，会进后台「待绑定」由管理员手动认领。
 */
export function SupportSheet({ open, onClose, page }) {
  const { user } = useAuth();
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!user) return;
    try {
      await navigator.clipboard.writeText(user.uuid);
      setCopied(true);
      toast('已复制 uuid');
    } catch {
      toast('复制失败，请长按选择');
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="支持校园墙">
      <div className="stack-lg">
        <p className="muted">
          服务器和域名都是自费的。如果想支持一下，可以在爱发电赞助 —— 不会解锁什么特权，
          只会给你加一个「赞助者」头衔，以及在关于页里留个名（如果以后加的话）。
        </p>

        <div className="support-step">
          <span className="support-step-no">1</span>
          <div className="grow">
            <strong>复制你的标识</strong>
            <p className="meta">下单时把它填进「留言」，我们就能把订单算到你头上。</p>
            <div className="support-uuid">
              <code>{user ? user.uuid : '登录后可见'}</code>
              <button className="btn btn-sm btn-secondary" type="button" onClick={copy} disabled={!user}>
                {copied ? '已复制' : '复制'}
              </button>
            </div>
            <p className="meta">也可以用注册邮箱（{user ? user.email : '—'}），效果一样。</p>
          </div>
        </div>

        <div className="support-step">
          <span className="support-step-no">2</span>
          <div className="grow">
            <strong>去爱发电下单</strong>
            <p className="meta">留言里填上刚才复制的那串，付款后头衔会自动到账。</p>
          </div>
        </div>

        <a className="btn btn-primary btn-block" href={page} target="_blank" rel="noreferrer">
          <IconLink size={17} /> 打开爱发电主页
        </a>

        <p className="meta support-foot">
          <IconHeart size={13} /> 赞助不是必须的。不赞助也能用全部功能。
        </p>
      </div>
    </Sheet>
  );
}

export default SupportSheet;
