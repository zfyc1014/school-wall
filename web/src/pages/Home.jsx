import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { Announcement } from '../components/Announcement.jsx';
import { ErrorState, Loading } from '../components/Empty.jsx';
import { renderMarkdown } from '../lib/markdown.js';

/**
 * 首页 = 一整块 Markdown（后台编辑，公开只读）。
 *
 * 为什么首页不再是信息流：信息流是「消费内容」，而首页应该是「告诉来的人这是哪」。
 * 表白墙本身挪到了 /#/wall（dock 第二项），首页留给站方写介绍、规则、活动。
 * 内容来源 GET /api/home；后台「首页」视图整块编辑。
 */
export function HomePage({ site }) {
  const [state, setState] = useState({ loading: true, markdown: '', error: '' });

  useEffect(() => {
    let alive = true;
    api.home()
      .then((data) => {
        if (!alive) return;
        setState({ loading: false, markdown: (data && data.markdown) || '', error: '' });
      })
      .catch((err) => {
        if (!alive) return;
        setState({ loading: false, markdown: '', error: err.message || '首页加载失败' });
      });
    return () => { alive = false; };
  }, []);

  // Markdown 只在内容变化时解析一次：滚动/重渲染不该重新跑正则
  const html = useMemo(() => renderMarkdown(state.markdown), [state.markdown]);

  return (
    <div className="page container home-page">
      <header className="home-head">
        <div className="container home-head-inner">
          <div>
            <h1 className="home-title">{site && site.siteName ? site.siteName : '校园墙'}</h1>
            <p className="home-sub">首页 · 由站方编辑</p>
          </div>
        </div>
      </header>

      <Announcement items={(site && site.announcements) || []} />

      {state.loading ? (
        <div className="home-md md-body" aria-busy="true">
          <div className="md-skeleton" />
          <div className="md-skeleton" style={{ width: '72%' }} />
          <div className="md-skeleton" style={{ width: '86%' }} />
        </div>
      ) : state.error ? (
        <ErrorState message={state.error} onRetry={() => window.location.reload()} />
      ) : (
        <article className="home-md md-body" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
}

export default HomePage;
