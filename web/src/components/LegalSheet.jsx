import { useId } from 'react';
import { useSheet } from '../hooks/useSheet.js';
import { IconClose } from './icons.jsx';

/**
 * 发布公约。
 *
 * 这份文案刻意写成正常人说话的样子，不是法律模板 ——
 * 原来的版本照抄了一套「香港法例 + UGC + 律师审阅」的免责声明，跟这个站点没关系，
 * 用户读两行就划走了，真正需要说清楚的事反而被埋掉。
 *
 * 站内真正要交代的只有三件：什么不能发、平台留了什么记录、被举报会怎样。
 * 其余的（未成年、内测期间的临时性）各占一小段就够。
 */
export function LegalSheet({ open, onClose, beta }) {
  const titleId = useId();
  const { ref, entered } = useSheet({ open, onClose });
  const version = beta?.version || '';
  const name = beta?.name || '内测版';

  return (
    <div
      className={`modal${entered ? ' open' : ''}`}
      id="legal"
      role="dialog"
      aria-modal="true"
      aria-hidden={!open}
      aria-labelledby={titleId}
    >
      <div className="sheet legal" ref={ref}>
        <div className="sheet-head">
          <h2 id={titleId}>发布公约</h2>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="关闭">
            <IconClose />
          </button>
        </div>

        <p>这是校园里的一块匿名公告板。写什么随你，但有几条得先讲明白。</p>

        <h3>别发这些</h3>
        <ul>
          <li>骂人、人身攻击、骚扰、威胁</li>
          <li>把别人的事指名道姓地写出来：真名、学号、宿舍号、照片、联系方式都算</li>
          <li>编造事实，或者冒充别人发帖</li>
          <li>色情、暴力、自残相关的内容</li>
          <li>别人的照片和文章，没经过同意就搬过来</li>
          <li>违法的事，以及帮别人违法的事</li>
        </ul>
        <p>违反的帖子会删掉；反复发、或者情节严重的，直接禁止发帖。</p>

        <h3>发出去之后</h3>
        <ul>
          <li>帖子先过人工审核，通过了才公开。没通过的不会显示，也不会单独通知你</li>
          <li>平台会记下提交时间和网络地址的不可逆哈希（不留原始 IP），用来处理举报和刷屏</li>
          <li>「匿名」说的是前台不显示你是谁。站内的数据反推不出你的身份</li>
        </ul>

        <h3>被举报了会怎样</h3>
        <p>
          帖子下面有举报按钮，理由会进后台队列，管理员尽快核查：内容违规就删，
          举报不成立就驳回。恶意举报同样会被限制。
        </p>

        <h3>未满 18 岁</h3>
        <p>请在监护人知情的情况下使用。涉及未成年的内容会优先处理。</p>

        <h3>内测期间</h3>
        <ul>
          <li>功能、界面、规则都可能随时改</li>
          <li>数据可能被定期清空，别把重要的东西只存在这里</li>
          <li>不收手机号，也没有账号体系，所以没有找回或导出数据这回事</li>
          <li>有问题或者有意见，用页面上的「内测反馈」告诉我们</li>
        </ul>

        <p className="stamp">
          {name} {version} · 公约会随内测调整，以页面上这一版为准
        </p>
      </div>
    </div>
  );
}
