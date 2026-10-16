import { useCallback, useEffect, useRef, useState } from 'react';
import { ToastProvider } from './context/ToastContext.jsx';
import { AuthProvider } from './context/AuthContext.jsx';
import { useScrollTopOnRouteChange, useRoute, navigate } from './router.jsx';
import { api } from './api/client.js';
import { Dock } from './components/Dock.jsx';
import { ComposerSheet } from './components/ComposerSheet.jsx';
import { HomePage } from './pages/Home.jsx';
import { AuthSheet } from './me/AuthSheet.jsx';
import { ProfilePage } from './me/ProfilePage.jsx';
import { UserPage } from './me/UserPage.jsx';
import { SettingsPage } from './me/SettingsPage.jsx';
import { FeedbackSheet } from './me/FeedbackSheet.jsx';
import { ForumPage } from './forum/ForumPage.jsx';
import { ThreadPage } from './forum/ThreadPage.jsx';
import { NewThreadPage } from './forum/NewThreadPage.jsx';
import { MessagesPage } from './social/MessagesPage.jsx';
import { ChatPage } from './social/ChatPage.jsx';
import { FriendsPage } from './social/FriendsPage.jsx';

/**
 * 应用外壳。
 *
 * 职责只有四件事：拉一次站点配置、按 hash 路由渲染页面、挂底部 dock、
 * 挂全局弹层（发帖 / 登录 / 反馈）。业务状态都在各页面自己手里 ——
 * 外壳越薄，页面越敢自己改。
 */

const FALLBACK_SITE = {
  version: '',
  siteName: '校园墙',
  announcements: [],
  features: { forum: true, dm: true }
};

function Shell() {
  const { path, segments } = useRoute();
  const [site, setSite] = useState(FALLBACK_SITE);
  const [composerOpen, setComposerOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [wallVersion, setWallVersion] = useState(0);
  const topRef = useRef(null);

  // 站点配置只拉一次：版本号、公告、功能开关都在里面
  useEffect(() => {
    let alive = true;
    api.site()
      .then((data) => { if (alive && data) setSite({ ...FALLBACK_SITE, ...data }); })
      .catch(() => { /* 配置拉不到就用兜底，不阻塞页面 */ });
    return () => { alive = false; };
  }, []);

  useScrollTopOnRouteChange(path, false);

  // dock 中间的主行动是上下文相关的：首页发告白、论坛里发主题、其它页面回首页
  const onCompose = useCallback(() => {
    if (segments[0] === 'forum') {
      navigate('/forum/new');
      return;
    }
    if (segments.length === 0) {
      setComposerOpen(true);
      return;
    }
    navigate('/');
  }, [segments]);

  const composeLabel = segments[0] === 'forum'
    ? '发帖'
    : segments.length === 0 ? '发布表白' : '回到首页发布';

  let page = null;
  if (segments.length === 0) {
    page = (
      <HomePage
        site={site}
        onCompose={() => setComposerOpen(true)}
        refreshToken={wallVersion}
      />
    );
  } else if (segments[0] === 'me') {
    page = <ProfilePage site={site} onOpenFeedback={() => setFeedbackOpen(true)} />;
  } else if (segments[0] === 'u' && segments[1]) {
    page = <UserPage uuid={segments[1]} />;
  } else if (segments[0] === 'settings') {
    page = <SettingsPage />;
  } else if (segments[0] === 'forum') {
    if (segments[1] === 'new') page = <NewThreadPage />;
    else if (segments[1]) page = <ThreadPage id={segments[1]} />;
    else page = <ForumPage />;
  } else if (segments[0] === 'messages') {
    page = segments[1] ? <ChatPage uuid={segments[1]} /> : <MessagesPage />;
  } else if (segments[0] === 'friends') {
    page = <FriendsPage />;
  } else {
    page = (
      <div className="page container">
        <div className="empty" style={{ paddingTop: 80 }}>
          <h3>页面不存在</h3>
          <p className="meta">地址可能已经失效</p>
          <div style={{ marginTop: 16 }}>
            <button className="btn btn-primary" type="button" onClick={() => navigate('/')}>回到首页</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app" ref={topRef}>
      <main className="page">{page}</main>

      <Dock onCompose={onCompose} composeLabel={composeLabel} />

      <ComposerSheet
        open={composerOpen}
        onClose={() => setComposerOpen(false)}
        onPublished={() => setWallVersion((v) => v + 1)}
      />

      <AuthSheet />

      <FeedbackSheet open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <Shell />
      </AuthProvider>
    </ToastProvider>
  );
}
