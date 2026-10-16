import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { Link, navigate } from '../router.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { Avatar } from '../components/Avatar.jsx';
import { UserBadge } from '../components/UserBadge.jsx';
import { Empty, ErrorState, Loading } from '../components/Empty.jsx';
import { IconUserPlus } from '../components/icons.jsx';
import { timeAgo } from '../lib/format.js';
import '../styles/social.css';

/**
 * 会话列表（#/messages）。
 *
 * 只做三件事：拉 /api/dm/conversations、渲染、把人送进聊天页。
 * 已读状态完全交给服务端（打开会话时的 GET /api/dm/:uuid 会标记），
 * 客户端不自己改未读数 —— 本地算已读迟早会和另一台设备上的状态打架。
 *
 * 未登录时不发请求：request() 遇到 401 会自动弹登录层，那样用户一进页面
 * 就被弹窗糊脸，不如老老实实给一个「登录后查看私信」。
 */

/** 一行会话。抽出来是因为列表里所有行的结构完全一致，只是数据不同。 */
function ConversationRow({ item }) {
  const peer = (item && item.peer) || null;
  const last = (item && item.last) || null;
  const unread = Number(item && item.unread) || 0;
  if (!peer) return null;

  return (
    <li>
      <Link to={'/messages/' + peer.uuid} className="list-item social-conv">
        <Avatar user={peer} size={48} className="social-conv-avatar" />
        <span className="grow social-conv-main">
          <span className="social-conv-top">
            <span className="social-conv-name truncate">{peer.nickname || '同学'}</span>
            <span className="social-conv-time">{last ? timeAgo(last.createdAt) : ''}</span>
          </span>
          <UserBadge user={peer} variant="compact" className="social-badge" />
          <span className="social-conv-bottom">
            <span className="social-conv-last truncate">
              {last ? (last.mine ? '我：' : '') + last.body : '还没有聊过，打个招呼吧'}
            </span>
            {unread > 0 ? <span className="social-unread">{unread > 99 ? '99+' : unread}</span> : null}
          </span>
        </span>
      </Link>
    </li>
  );
}

export function MessagesPage() {
  const { user, ready, openAuth } = useAuth();
  const myUuid = user ? user.uuid : '';

  const [items, setItems] = useState([]);
  const [status, setStatus] = useState('loading'); // loading | ready | error | idle
  const [error, setError] = useState('');

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setStatus('loading');
      setError('');
    }
    try {
      const data = await api.dm.conversations();
      setItems(Array.isArray(data && data.items) ? data.items : []);
      setStatus('ready');
    } catch (err) {
      // 静默刷新（切回标签页）失败就留着旧列表：为了一个后台请求把已有内容换成错误页不值得
      if (silent) return;
      setError((err && err.message) || '加载失败');
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    if (!ready) return undefined;
    if (!myUuid) {
      setItems([]);
      setStatus('idle');
      return undefined;
    }

    load();
    // 切回标签页/窗口时补一次：时间戳和未读数不该停在上次打开的那一刻
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

  return (
    <>
      <header className="page-head">
        <span className="page-head-spacer" aria-hidden="true" />
        <h1 className="page-title social-head-title">私信</h1>
        <Link to="/friends" className="btn-icon social-icon-btn" aria-label="好友与新的朋友">
          <IconUserPlus size={20} />
        </Link>
      </header>

      <div className="container">
        {!ready ? <Loading rows={3} /> : null}

        {ready && !user ? (
          <Empty
            title="登录后查看私信"
            hint="私信只有你和对方能看到，登录后才能收发"
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

        {ready && user && status === 'ready' && !items.length ? (
          <Empty
            title="还没有聊天"
            hint="去好友列表找同学聊聊，加了好友就能互发私信"
            action={(
              <button className="btn btn-secondary social-tap" type="button" onClick={() => navigate('/friends')}>
                去好友列表
              </button>
            )}
          />
        ) : null}

        {ready && user && status === 'ready' && items.length ? (
          <ul className="list social-conv-list">
            {items.map((item, index) => (
              <ConversationRow key={(item && item.peer && item.peer.uuid) || index} item={item} />
            ))}
          </ul>
        ) : null}
      </div>
    </>
  );
}

export default MessagesPage;
