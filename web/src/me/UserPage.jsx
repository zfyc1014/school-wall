import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { navigate } from '../router.jsx';
import { Avatar } from '../components/Avatar.jsx';
import { UserBadge } from '../components/UserBadge.jsx';
import { ErrorState, Loading } from '../components/Empty.jsx';
import { IconBack, IconChat, IconUserPlus, IconMore } from '../components/icons.jsx';
import { timeAgo } from '../lib/format.js';

/**
 * 他人主页。
 *
 * 关系决定了能做什么（服务端给 relation 字段，前端只做映射）：
 *   none        → 加好友
 *   pending_out → 等待对方验证
 *   pending_in  → 同意 / 拒绝
 *   friend      → 发消息 + 删除好友
 *   blocked     → 已拉黑（可解除）
 *   blocked_by  → 对方拉黑了我（只能看到资料）
 */
export function UserPage({ uuid }) {
  const { user, requireLogin } = useAuth();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await api.users.get(uuid);
      setData(result);
    } catch (err) {
      setError(err.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [uuid]);

  useEffect(() => { load(); }, [load]);

  const act = (fn) => requireLogin(async () => {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (err) {
      toast(err.message || '操作失败');
    } finally {
      setBusy(false);
      setMenuOpen(false);
    }
  });

  const head = (
    <div className="page-head">
      <div className="container row" style={{ width: '100%', paddingInline: 0 }}>
        <button className="btn-icon" type="button" aria-label="返回" onClick={() => navigate('/')}>
          <IconBack size={20} />
        </button>
        <span className="page-title">个人主页</span>
      </div>
    </div>
  );

  if (loading) return <div className="container" style={{ paddingTop: 16 }}>{head}<Loading rows={2} /></div>;
  if (error) return <div className="container" style={{ paddingTop: 16 }}>{head}<ErrorState message={error} onRetry={load} /></div>;

  const target = data.user;
  const relation = data.relation;
  const stats = target.stats || {};

  return (
    <div className="container">
      {head}

      <section className="card card-pad" style={{ marginTop: 12 }}>
        <div className="row" style={{ gap: 14, alignItems: 'flex-start' }}>
          <Avatar user={target} size={60} />
          <div className="grow">
            <h2 className="me-name">{target.nickname}</h2>
            <UserBadge user={target} variant="full" />
            {target.bio ? <p className="me-bio">{target.bio}</p> : null}
            <p className="meta" style={{ marginTop: 6 }}>加入于 {timeAgo(target.createdAt)}</p>
          </div>
          <div className="post-menu">
            <button className="btn-icon" type="button" aria-label="更多" onClick={() => setMenuOpen((v) => !v)}>
              <IconMore size={18} />
            </button>
            {menuOpen ? (
              <div className="post-menu-pop glass glass-strong">
                {relation === 'friend' ? (
                  <button
                    className="list-item"
                    type="button"
                    disabled={busy}
                    onClick={() => act(async () => {
                      if (!window.confirm('删除好友后需要重新添加，聊天记录会保留。确定吗？')) return;
                      await api.friends.remove(target.uuid);
                      toast('已删除好友');
                    })}
                  >
                    删除好友
                  </button>
                ) : null}
                {relation === 'blocked' ? (
                  <button
                    className="list-item"
                    type="button"
                    disabled={busy}
                    onClick={() => act(async () => { await api.users.unblock(target.uuid); toast('已解除拉黑'); })}
                  >
                    解除拉黑
                  </button>
                ) : (
                  <button
                    className="list-item"
                    type="button"
                    disabled={busy}
                    onClick={() => act(async () => {
                      if (!window.confirm('拉黑后对方不能再给你发私信，好友关系也会解除。')) return;
                      await api.users.block(target.uuid);
                      toast('已拉黑');
                    })}
                  >
                    拉黑
                  </button>
                )}
              </div>
            ) : null}
          </div>
        </div>

        <div className="me-stats">
          {[['发布', stats.posts], ['主题', stats.threads], ['回复', stats.replies], ['好友', stats.friends]].map(([label, value]) => (
            <div key={label} className="me-stat">
              <strong>{Number(value) || 0}</strong>
              <span className="meta">{label}</span>
            </div>
          ))}
        </div>
      </section>

      <div className="me-actions">
        {relation === 'self' ? (
          <button className="btn btn-secondary btn-block" type="button" onClick={() => navigate('/me')}>这是我的主页</button>
        ) : null}

        {relation === 'none' ? (
          <button
            className="btn btn-primary btn-block"
            type="button"
            disabled={busy}
            onClick={() => act(async () => {
              const result = await api.friends.request(target.uuid, '');
              toast(result.status === 'accepted' ? '你们已经成为好友' : '好友请求已发送');
            })}
          >
            <IconUserPlus size={17} /> 加好友
          </button>
        ) : null}

        {relation === 'pending_out' ? (
          <>
            <button className="btn btn-secondary btn-block" type="button" disabled>等待对方验证</button>
            <button
              className="btn btn-ghost btn-block"
              type="button"
              disabled={busy}
              onClick={() => act(async () => { await api.friends.cancelRequest(target.uuid); toast('已撤回好友请求'); })}
            >
              撤回请求
            </button>
          </>
        ) : null}

        {relation === 'pending_in' ? (
          <>
            <button
              className="btn btn-primary btn-block"
              type="button"
              disabled={busy}
              onClick={() => act(async () => { await api.friends.accept(target.uuid); toast('已同意'); })}
            >
              同意好友请求
            </button>
            <button
              className="btn btn-secondary btn-block"
              type="button"
              disabled={busy}
              onClick={() => act(async () => { await api.friends.decline(target.uuid); toast('已拒绝'); })}
            >
              拒绝
            </button>
          </>
        ) : null}

        {relation === 'friend' ? (
          <button className="btn btn-primary btn-block" type="button" onClick={() => navigate('/messages/' + target.uuid)}>
            <IconChat size={17} /> 发消息
          </button>
        ) : null}

        {relation === 'blocked' ? (
          <button
            className="btn btn-secondary btn-block"
            type="button"
            disabled={busy}
            onClick={() => act(async () => { await api.users.unblock(target.uuid); toast('已解除拉黑'); })}
          >
            解除拉黑
          </button>
        ) : null}

        {relation === 'blocked_by' ? (
          <button className="btn btn-secondary btn-block" type="button" disabled>对方已限制你的访问</button>
        ) : null}
      </div>
    </div>
  );
}

export default UserPage;
