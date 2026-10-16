import { useMemo, useState } from 'react';
import { Sheet } from '../components/Sheet.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { IconHeart, IconLink } from '../components/icons.jsx';

/**
 * 支持校园墙（爱发电）。
 *
 * 只有站点配置了 AFDIAN_PAGE 才会走到这里（入口本身也是条件渲染的）。
 *
 * 这个弹层最关键的不是「打钱」，而是让用户知道**留言该写什么**：
 * 爱发电的订单不携带付款人邮箱，唯一能把订单和账号连起来的只有下单留言；
 * 头衔档位也靠留言里的「头衔：xxx」来指定。所以这里直接给出一段可以一键复制的模板，
 * 用户只需要粘贴 —— 少一步手写，就少一批匹配不上的订单。
 */
export function SupportSheet({ open, onClose, page, tiers = [], customKeyword = '头衔' }) {
  const { user } = useAuth();
  const toast = useToast();
  const [copied, setCopied] = useState('');

  // 只有配置了「自定义」档位时才需要在模板里带那一行
  const hasCustom = tiers.some((t) => t.title === '@custom');

  const template = useMemo(() => {
    const lines = ['标识：' + (user ? user.uuid : '（先登录获取）')];
    if (hasCustom) lines.push(customKeyword + '：想要的名字（发电 10 元及以上才需要这行）');
    return lines.join('\n');
  }, [user, hasCustom, customKeyword]);

  const copy = async (text, tag) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(tag);
      toast(tag === 'uuid' ? '已复制你的标识' : '已复制，粘到爱发电的留言框即可');
    } catch {
      toast('复制失败，请长按选择');
    }
  };

  const tierText = (tier) => (
    tier.title === '@custom' ? '自定义头衔' : `头衔「${tier.title}」`
  );

  return (
    <Sheet open={open} onClose={onClose} title="支持校园墙">
      <div className="stack-lg">
        <p className="muted">
          服务器和域名都是自费的。赞助会按金额自动给一个头衔（不需要申请、也不需要等审核），
          除此之外没有别的好处 —— 所有功能不赞助也能用。
        </p>

        {tiers.length ? (
          <ul className="support-tiers">
            {tiers.map((tier) => (
              <li key={tier.amount}>
                <span className="support-tier-amount">发电 ≥{Number(tier.amount)} 元</span>
                <span className="support-tier-title">{tierText(tier)}</span>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="support-step">
          <span className="support-step-no">1</span>
          <div className="grow">
            <strong>复制下面这段</strong>
            <p className="meta">下单时整段粘进爱发电的「留言」框，其余什么都不用写。</p>
            <pre className="support-template">{template}</pre>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn btn-sm btn-secondary" type="button" disabled={!user} onClick={() => copy(template, 'template')}>
                {copied === 'template' ? '已复制' : '复制留言模板'}
              </button>
              <button className="btn btn-sm btn-ghost" type="button" disabled={!user} onClick={() => copy(user.uuid, 'uuid')}>
                {copied === 'uuid' ? '已复制' : '只复制标识'}
              </button>
            </div>
            <p className="meta">
              标识就是你的 uuid（{user ? user.email : '登录后可见'} 这个注册邮箱也可以，二选一）。
            </p>
          </div>
        </div>

        <div className="support-step">
          <span className="support-step-no">2</span>
          <div className="grow">
            <strong>去爱发电下单</strong>
            <p className="meta">
              付款成功后头衔会自动到账（几秒内）。没写留言也不会丢 —— 订单会进后台待认领，
              你可以把订单号发给管理员手动绑定。
            </p>
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
