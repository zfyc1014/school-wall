import { useEffect, useState } from 'react';
import { navigate, useRoute } from '../router.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../api/client.js';
import { IconChat, IconForum, IconHome, IconPlus, IconUser } from './icons.jsx';

/**
 * 底部 dock。
 *
 * 视觉：液态玻璃（半透明 + 模糊饱和 + 内高光），内容从它下面穿过去，
 * 这样滚动时才有「玻璃」的观感 —— 不透明底栏是做不出这个效果的。
 *
 * 结构：四个 tab + 中间一个主行动键。主行动是上下文相关的：
 * 首页发告白、论坛发主题，其余页面回首页再发（避免在消息页出现「发帖」这种怪事）。
 */

const TABS = [
  { key: 'home', label: '首页', icon: IconHome, to: '/' },
  { key: 'forum', label: '论坛', icon: IconForum, to: '/forum' },
  { key: 'messages', label: '消息', icon: IconChat, to: '/messages' },
  { key: 'me', label: '我的', icon: IconUser, to: '/me' }
];

function activeKey(path) {
  if (path === '/' || path === '') return 'home';
  if (path.startsWith('/forum')) return 'forum';
  if (path.startsWith('/messages') || path.startsWith('/friends')) return 'messages';
  if (path.startsWith('/me') || path.startsWith('/u/') || path.startsWith('/settings')) return 'me';
  return '';
}

export function Dock({ onCompose, composeLabel = '发布' }) {
  const { path } = useRoute();
  const { user } = useAuth();
  const [unread, setUnread] = useState(0);
  const active = activeKey(path);

  // 未读私信：登录后每 30 秒轮询一次，切页时立刻刷一次（打开会话后红点要马上消失）
  useEffect(() => {
    if (!user) {
      setUnread(0);
      return undefined;
    }
    let alive = true;
    const load = async () => {
      try {
        const data = await api.dm.unread();
        if (alive) setUnread(Number(data && data.count) || 0);
      } catch {
        /* 未读数失败不打扰用户 */
      }
    };
    load();
    const timer = setInterval(load, 30000);
    return () => { alive = false; clearInterval(timer); };
  }, [user, path]);

  return (
    <nav className="dock" aria-label="主导航">
      <div className="dock-inner">
        {TABS.slice(0, 2).map((tab) => (
          <DockTab key={tab.key} tab={tab} active={active === tab.key} />
        ))}

        <button
          type="button"
          className="dock-compose"
          onClick={onCompose}
          aria-label={composeLabel}
        >
          <IconPlus size={24} strokeWidth={1.9} />
        </button>

        {TABS.slice(2).map((tab) => (
          <DockTab
            key={tab.key}
            tab={tab}
            active={active === tab.key}
            badge={tab.key === 'messages' ? unread : 0}
          />
        ))}
      </div>
    </nav>
  );
}

function DockTab({ tab, active, badge = 0 }) {
  const Icon = tab.icon;
  return (
    <button
      type="button"
      className={'dock-tab' + (active ? ' is-active' : '')}
      aria-current={active ? 'page' : undefined}
      onClick={() => navigate(tab.to)}
    >
      <span className="dock-icon"><Icon size={22} strokeWidth={active ? 2 : 1.7} /></span>
      <span>{tab.label}</span>
      {badge > 0 ? <span className="dock-dot">{badge > 99 ? '99+' : badge}</span> : null}
    </button>
  );
}

export default Dock;
