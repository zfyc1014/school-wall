import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { navigate } from '../router.jsx';
import { Avatar } from '../components/Avatar.jsx';
import { UserBadge } from '../components/UserBadge.jsx';
import { Empty, Loading } from '../components/Empty.jsx';
import { IconChat, IconSettings, IconUserPlus, IconInfo, IconLock, IconHeart } from '../components/icons.jsx';
import { SupportSheet } from './SupportSheet.jsx';
import { IconMail, IconUsers } from '../components/icons.jsx';
import { timeAgo } from '../lib/format.js';

/**
 * 我的主页。
 *
 * 信息层级刻意固定为：**学校 → 头衔 → 等级**（UserBadge variant="full"）。
 * 学校在最前是产品要求（选定时就承诺过「会显示在主页最前面」），
 * 等级排在头衔之后，空间不够时先省略等级。
 */
export function ProfilePage({ site, onOpenFeedback }) {
  const { user, ready, openAuth, refresh, logout } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [supportOpen, setSupportOpen] = useState(false);
  // 开发者与感谢名单：公开接口，登录前也能看（页面本身要求登录，这里只拉一次）
  const [credits, setCredits] = useState({ developers: [], thanks: [] });
  // 只有站点配置了爱发电主页才显示入口：没配置就完全不提这件事
  const afdian = (site && site.afdian) || null;
  const afdianPage = afdian && afdian.page ? afdian.page : '';

  useEffect(() => {
    let alive = true;
    api.credits()
      .then((data) => { if (alive && data) setCredits({ developers: data.developers || [], thanks: data.thanks || [] }); })
      .catch(() => { /* 名单拉不到就不显示，不影响主流程 */ });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (ready && user) refresh();
    // 每次进入主页刷新一次统计：发帖/加好友之后数字要跟着变
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const doLogout = useCallback(async () => {
    if (!window.confirm('确定要退出登录吗？')) return;
    setBusy(true);
    try {
      await logout();
      toast('已退出登录');
      navigate('/');
    } finally {
      setBusy(false);
    }
  }, [logout, toast]);

  if (!ready) {
    return <div className="container" style={{ paddingTop: 24 }}><Loading rows={2} /></div>;
  }

  if (!user) {
    return (
      <div className="container" style={{ paddingTop: 24 }}>
        <Empty
          title="还没有登录"
          hint="用邮箱验证码登录后，才能发帖、加好友、私信"
          action={<button className="btn btn-primary" type="button" onClick={openAuth}>登录 / 注册</button>}
        />
      </div>
    );
  }

  const stats = user.stats || {};
  const next = user.nextLevelExp;
  const progress = next ? Math.max(0, Math.min(100, Math.round((user.exp / next) * 100))) : 100;

  return (
    <div className="container">
      <div className="home-head">
        <div className="container spread">
          <h1 className="home-title">我的</h1>
          <button className="btn-icon" type="button" aria-label="设置" onClick={() => navigate('/settings')}>
            <IconSettings size={20} />
          </button>
        </div>
      </div>

      <section className="card card-pad" style={{ marginTop: 12 }}>
        <div className="row" style={{ gap: 14, alignItems: 'flex-start' }}>
          <Avatar user={user} size={60} />
          <div className="grow">
            <h2 className="me-name">{user.nickname}</h2>
            <UserBadge user={user} variant="full" />
            {user.bio ? <p className="me-bio">{user.bio}</p> : null}
          </div>
        </div>

        <div className="me-level">
          <div className="me-level-bar" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: progress + '%' }} />
          </div>
          <p className="meta">
            {next ? `Lv.${user.level} · 距离 Lv.${user.level + 1} 还差 ${Math.max(0, next - user.exp)} 经验` : `Lv.${user.level} · 已满级`}
          </p>
        </div>

        <div className="me-stats">
          {[['发布', stats.posts], ['评论', stats.comments], ['主题', stats.threads], ['好友', stats.friends]].map(([label, value]) => (
            <div key={label} className="me-stat">
              <strong>{Number(value) || 0}</strong>
              <span className="meta">{label}</span>
            </div>
          ))}
        </div>
      </section>

      <div className="list" style={{ marginTop: 16 }}>
        <button className="list-item" type="button" onClick={() => navigate('/friends')}>
          <IconUserPlus size={20} />
          <span className="grow">好友</span>
          <span className="meta">{Number(stats.friends) || 0}</span>
        </button>
        <button className="list-item" type="button" onClick={() => navigate('/messages')}>
          <IconChat size={20} />
          <span className="grow">私信</span>
        </button>
        <button className="list-item" type="button" onClick={() => navigate('/settings')}>
          <IconSettings size={20} />
          <span className="grow">编辑资料</span>
        </button>
        <button className="list-item" type="button" onClick={onOpenFeedback}>
          <IconInfo size={20} />
          <span className="grow">意见反馈</span>
        </button>
        {afdianPage ? (
          <button className="list-item" type="button" onClick={() => setSupportOpen(true)}>
            <IconHeart size={20} />
            <span className="grow">支持校园墙</span>
            <span className="meta">爱发电</span>
          </button>
        ) : null}
      </div>

      <div className="list" style={{ marginTop: 16 }}>
        <div className="list-item" style={{ cursor: 'default' }}>
          <IconLock size={20} />
          <span className="grow">账号</span>
          <span className="meta">{user.email}</span>
        </div>
        <div className="list-item" style={{ cursor: 'default' }}>
          <span className="grow">注册时间</span>
          <span className="meta">{timeAgo(user.createdAt)}</span>
        </div>
      </div>

      {/* 联系作者 + 名单：都放在「我的」，不打扰主界面 */}
      <section className="card card-pad" style={{ marginTop: 16 }}>
        <h2 className="card-title">关于</h2>
        <p className="meta" style={{ marginBottom: 12 }}>
          校园墙由学生自建自维护，服务器与域名都是自费的。
        </p>

        <a className="list-item" href="mailto:huan_zhe@outlook.com" style={{ paddingInline: 0 }}>
          <IconMail size={20} />
          <span className="grow">联系作者</span>
          <span className="meta">huan_zhe@outlook.com</span>
        </a>

        <div className="credits-block">
          <div className="credits-head">
            <IconUsers size={16} />
            <strong>开发者</strong>
          </div>
          <div className="credits-tags">
            {(credits.developers || []).map((name) => <span key={name} className="chip">{name}</span>)}
          </div>
        </div>

        <div className="credits-block">
          <div className="credits-head">
            <IconHeart size={16} />
            <strong>感谢名单</strong>
            <span className="meta">不分先后</span>
          </div>
          {credits.thanks && credits.thanks.length ? (
            <div className="credits-tags">
              {credits.thanks.map((name) => <span key={name} className="chip chip-soft">{name}</span>)}
            </div>
          ) : (
            <p className="meta">还没有赞助记录。想支持的话，入口在上面「支持校园墙」。</p>
          )}
        </div>
      </section>

      <div style={{ margin: '20px 0 32px' }}>
        <button className="btn btn-danger btn-block" type="button" disabled={busy} onClick={doLogout}>
          退出登录
        </button>
      </div>

      {afdianPage ? (
        <SupportSheet
          open={supportOpen}
          onClose={() => setSupportOpen(false)}
          page={afdianPage}
          tiers={afdian.tiers || []}
          customKeyword={afdian.customKeyword || '头衔'}
        />
      ) : null}
    </div>
  );
}

export default ProfilePage;
