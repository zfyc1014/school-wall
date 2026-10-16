import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { navigate } from '../router.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { Avatar } from '../components/Avatar.jsx';
import { UserBadge } from '../components/UserBadge.jsx';
import { Sheet } from '../components/Sheet.jsx';
import { Empty, ErrorState, Loading } from '../components/Empty.jsx';
import { IconMore } from '../components/icons.jsx';
import '../styles/social.css';

/**
 * 好友 + 新的朋友（#/friends）。
 *
 * 为什么只支持「按 uuid 加好友」：本站没有全局用户搜索，也不打算加。
 * 校园产品里可搜索的用户目录 ≈ 一键导出全校名单，代价远大于便利；
 * 因此加好友必须**线下先拿到对方的 uuid 或主页链接**（#/u/uuid），
 * 输入框顺手把整条链接归一化成 uuid，省得用户自己抠。
 */

/** 从「整条主页链接 / #/u/uuid / 裸 uuid」里取出 uuid */
function normalizeUuid(raw) {
  const text = String(raw || '').trim().replace(/^#+/, '');
  if (!text) return '';
  const parts = text.split(/[/?#\s]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/** 好友接口返回的是 {user, message, createdAt} 包装，这里兼容一下裸 User */
function peerOf(item) {
  if (!item) return null;
  return item.user || item;
}

export function FriendsPage() {
  const { user, ready, openAuth, requireLogin } = useAuth();
  const toast = useToast();
  const myUuid = user ? user.uuid : '';

  const [tab, setTab] = useState('friends'); // friends | requests
  const [data, setData] = useState({ friends: [], incoming: [], outgoing: [] });
  const [status, setStatus] = useState('loading'); // loading | ready | error | idle
  const [error, setError] = useState('');
  const [uuidInput, setUuidInput] = useState('');
  const [msgInput, setMsgInput] = useState(''); // 验证消息（选填，服务端最多 60 字）
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState('');           // 正在处理的那个 uuid
  const [menuUser, setMenuUser] = useState(null); // 「更多」菜单里的用户
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setStatus('loading');
      setError('');
    }
    try {
      const res = await api.friends.list();
      setData({
        friends: Array.isArray(res && res.friends) ? res.friends : [],
        incoming: Array.isArray(res && res.incoming) ? res.incoming : [],
        outgoing: Array.isArray(res && res.outgoing) ? res.outgoing : []
      });
      setStatus('ready');
    } catch (err) {
      if (silent) return;
      setError((err && err.message) || '加载失败');
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    if (!ready) return undefined;
    if (!myUuid) {
      setData({ friends: [], incoming: [], outgoing: [] });
      setStatus('idle');
      return undefined;
    }
    load();
    // 好友请求是别人发起的：切回页面时补一次，别让红点停太久
    const onVisible = () => {
      if (!document.hidden) load({ silent: true });
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [ready, myUuid, load]);

  /** 同意/拒绝/删除都长一个样：先锁住按钮，成功后 toast + 刷新列表 */
  const run = useCallback((action, uuid, okMessage) => {
    requireLogin(async () => {
      setBusy(uuid);
      try {
        await action();
        if (okMessage) toast(okMessage);
        await load({ silent: true });
      } catch (err) {
        toast((err && err.message) || '操作失败');
      } finally {
        setBusy('');
      }
    });
  }, [load, requireLogin, toast]);

  const add = useCallback(() => {
    const target = normalizeUuid(uuidInput);
    if (!target || target.length < 8) {
      toast('这段看起来不是 uuid，让对方把主页链接发给你');
      return;
    }
    if (target === myUuid) {
      toast('不能加自己为好友');
      return;
    }
    requireLogin(async () => {
      setAdding(true);
      try {
        const res = await api.friends.request(target, msgInput.trim());
        if (res && res.status === 'accepted') toast('你们已成为好友');
        else toast('已发送好友请求');
        setUuidInput('');
        setMsgInput('');
        await load({ silent: true });
        // 刚发出的请求在「新的朋友」里，直接切过去，用户才知道东西去哪了
        setTab('requests');
      } catch (err) {
        toast((err && err.message) || '发送失败');
      } finally {
        setAdding(false);
      }
    });
  }, [uuidInput, msgInput, myUuid, requireLogin, toast, load]);

  const removeFriend = useCallback(() => {
    const target = menuUser;
    if (!target) return;
    run(() => api.friends.remove(target.uuid), target.uuid, '已删除好友');
    setMenuUser(null);
    setConfirming(false);
  }, [menuUser, run]);

  const { friends, incoming, outgoing } = data;
  const requests = incoming.concat(outgoing);

  return (
    <>
      <header className="page-head">
        <span className="page-head-spacer" aria-hidden="true" />
        <h1 className="page-title social-head-title">好友</h1>
        <span className="page-head-spacer" aria-hidden="true" />
      </header>

      <div className="container">
        <div className="social-toolbar">
          <div className="social-add">
            <input
              className="input social-add-input"
              type="text"
              value={uuidInput}
              placeholder="粘贴主页链接或 uuid"
              aria-label="对方的 uuid 或主页链接"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="send"
              onChange={(event) => setUuidInput(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add(); } }}
            />
            <button
              className="btn btn-primary social-tap"
              type="button"
              onClick={add}
              disabled={adding || !uuidInput.trim()}
            >
              {adding ? '发送中…' : '添加'}
            </button>
          </div>
          <input
            className="input social-msg-input"
            type="text"
            value={msgInput}
            maxLength={60}
            placeholder="验证消息（选填，比如「我是三班的」）"
            aria-label="好友验证消息"
            enterKeyHint="send"
            onChange={(event) => setMsgInput(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add(); } }}
          />
          <p className="meta social-tip">
            这里没有全局搜索：让对方把主页链接（#/u/uuid）或 uuid 发给你，粘到上面就能加。
          </p>

          <div className="seg social-seg" role="tablist" aria-label="好友与请求">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'friends'}
              onClick={() => setTab('friends')}
            >
              好友
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'requests'}
              onClick={() => setTab('requests')}
            >
              新的朋友（{incoming.length}）
            </button>
          </div>
        </div>

        <div className="social-panel" role="tabpanel">
          {!ready ? <Loading rows={3} /> : null}

          {ready && !user ? (
            <Empty
              title="登录后查看好友"
              hint="登录后可以把同学加成好友，互相发私信"
              action={(
                <button className="btn btn-primary social-tap" type="button" onClick={openAuth}>
                  登录 / 注册
                </button>
              )}
            />
          ) : null}

          {ready && user && status === 'loading' ? <Loading rows={3} /> : null}

          {ready && user && status === 'error' ? (
            <ErrorState message={error} onRetry={() => load()} />
          ) : null}

          {ready && user && status === 'ready' && tab === 'friends' ? (
            friends.length ? (
              <ul className="list social-list">
                {friends.map((item) => {
                  const peer = peerOf(item);
                  if (!peer) return null;
                  return (
                    <li key={peer.uuid} className="list-item social-user">
                      <Avatar user={peer} size={44} />
                      <div className="grow social-user-main">
                        <span className="social-user-name truncate">{peer.nickname || '同学'}</span>
                        <UserBadge user={peer} variant="full" className="social-badge" />
                      </div>
                      <div className="social-actions">
                        <button
                          className="btn btn-secondary btn-sm social-tap"
                          type="button"
                          onClick={() => navigate('/messages/' + peer.uuid)}
                        >
                          发消息
                        </button>
                        <button
                          className="btn-icon"
                          type="button"
                          aria-label={'更多操作：' + (peer.nickname || '同学')}
                          onClick={() => { setMenuUser(peer); setConfirming(false); }}
                        >
                          <IconMore size={18} />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <Empty
                title="还没有好友"
                hint="让对方把主页链接（#/u/uuid）或 uuid 发给你，粘到上面的输入框就能加"
              />
            )
          ) : null}

          {ready && user && status === 'ready' && tab === 'requests' ? (
            requests.length ? (
              <ul className="list social-list">
                {incoming.map((item) => {
                  const peer = peerOf(item);
                  if (!peer) return null;
                  return (
                    <li key={'in-' + peer.uuid} className="list-item social-req">
                      <div className="social-req-head">
                        <Avatar user={peer} size={44} />
                        <div className="grow social-user-main">
                          <span className="social-user-name truncate">{peer.nickname || '同学'}</span>
                          <UserBadge user={peer} variant="compact" className="social-badge" />
                        </div>
                      </div>
                      {item.message ? <p className="social-req-msg">{item.message}</p> : null}
                      <div className="social-req-actions">
                        <button
                          className="btn btn-secondary btn-sm social-tap"
                          type="button"
                          disabled={busy === peer.uuid}
                          onClick={() => run(() => api.friends.decline(peer.uuid), peer.uuid, '已拒绝')}
                        >
                          拒绝
                        </button>
                        <button
                          className="btn btn-primary btn-sm social-tap"
                          type="button"
                          disabled={busy === peer.uuid}
                          onClick={() => run(() => api.friends.accept(peer.uuid), peer.uuid, '已同意，可以聊天了')}
                        >
                          同意
                        </button>
                      </div>
                    </li>
                  );
                })}
                {outgoing.map((item) => {
                  const peer = peerOf(item);
                  if (!peer) return null;
                  return (
                    <li key={'out-' + peer.uuid} className="list-item social-user">
                      <Avatar user={peer} size={44} />
                      <div className="grow social-user-main">
                        <span className="social-user-name truncate">{peer.nickname || '同学'}</span>
                        <UserBadge user={peer} variant="compact" className="social-badge" />
                        {item.message ? <span className="social-user-msg">{item.message}</span> : null}
                      </div>
                      <span className="social-waiting">等待验证</span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <Empty
                title="没有新的朋友"
                hint="收到的请求和等待验证的请求都会出现在这里"
              />
            )
          ) : null}
        </div>
      </div>

      <Sheet
        open={Boolean(menuUser)}
        onClose={() => { setMenuUser(null); setConfirming(false); }}
        title={menuUser ? menuUser.nickname : '好友'}
      >
        {menuUser ? (
          confirming ? (
            <div className="social-confirm">
              <p>确定删除 <strong>{menuUser.nickname}</strong> 吗？</p>
              <p className="meta">聊天记录会保留，但你们不能再互发私信。</p>
              <div className="social-confirm-actions">
                <button className="btn btn-secondary social-tap" type="button" onClick={() => setConfirming(false)}>
                  取消
                </button>
                <button
                  className="btn btn-danger social-tap"
                  type="button"
                  disabled={busy === menuUser.uuid}
                  onClick={removeFriend}
                >
                  删除好友
                </button>
              </div>
            </div>
          ) : (
            <div className="social-menu">
              <button
                className="btn btn-secondary social-tap social-menu-item"
                type="button"
                onClick={() => { const target = menuUser; setMenuUser(null); navigate('/messages/' + target.uuid); }}
              >
                发消息
              </button>
              <button
                className="btn btn-danger social-tap social-menu-item"
                type="button"
                onClick={() => setConfirming(true)}
              >
                删除好友
              </button>
            </div>
          )
        ) : null}
      </Sheet>
    </>
  );
}

export default FriendsPage;
