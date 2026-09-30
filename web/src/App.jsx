import { useCallback, useEffect, useMemo, useState } from 'react';
import { TopNav, Toolbar } from './components/Chrome.jsx';
import { Wall } from './components/Wall.jsx';
import { Footer, TabBar } from './components/Footer.jsx';
import { ComposerSheet, ReportSheet } from './components/ComposerSheet.jsx';
import { LegalSheet } from './components/LegalSheet.jsx';
import { BetaBanner } from './components/BetaBanner.jsx';
import { BetaNotice } from './components/BetaNotice.jsx';
import { FeedbackSheet } from './components/FeedbackSheet.jsx';
import { ToastProvider, useToast } from './context/ToastContext.jsx';
import { GateProvider, useGate } from './context/GateContext.jsx';
import { useWall } from './hooks/useWall.js';
import { createAdapter, setGateResolver } from './data/adapters.js';
import {
  loadLikedIds,
  saveLikedIds,
  shouldShowBetaNotice,
  markBetaNoticeSeen,
} from './lib/storage.js';

const SITE_NAME = import.meta.env.VITE_SITE_NAME || '表白墙';
/**
 * 校名：**留空就不渲染**（不写占位、不留悬空的分隔点）。
 *
 * 之前这里是 `|| '示例大学'`，于是「清空 VITE_SCHOOL_NAME」这个动作完全无效 ——
 * 页面照样显示「· 示例大学」。现在按运营方的真实意图处理：
 * 没填校名就当作「这个站点不属于任何学校」，顶栏与首屏都不出现校名。
 * 填了真名（例如 `VITE_SCHOOL_NAME=某某大学`）则自动出现在两处。
 */
const SCHOOL_NAME = String(import.meta.env.VITE_SCHOOL_NAME || '').trim();

/** 数据源状态文案：让「现在连的是谁」始终可见，避免误以为在发真内容 */
const SOURCE_NOTES = {
  api: '已连接后端 API · 内容先审后发',
  local: '本地演示数据 · 未连接后端 API',
  fallback: '后端连接失败 · 已回落到本地演示数据',
};

function WallApp() {
  const toast = useToast();
  const gate = useGate();

  const [adapter, setAdapter] = useState(null);
  const [source, setSource] = useState('local');
  const [mode, setMode] = useState('auto');
  const [bootError, setBootError] = useState('');
  const [ready, setReady] = useState(false);

  const [likedIds, setLikedIdsState] = useState(() => loadLikedIds());
  const setLikedIds = useCallback((next) => {
    setLikedIdsState(next);
    saveLikedIds(next);
  }, []);

  const [composerOpen, setComposerOpen] = useState(false);
  const [legalOpen, setLegalOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [noticeSeen, setNoticeSeen] = useState(() => !shouldShowBetaNotice(gate.beta.version));

  // 把「确保已通过内测验证」交给数据层：写请求遇到 403 gate_required
  // 会自动弹验证弹层，通过后重试原来那次请求。
  useEffect(() => {
    setGateResolver(gate.ensureVerified);
    return () => setGateResolver(null);
  }, [gate.ensureVerified]);

  // 探测数据源：auto 模式下后端不可用就静默回落本地演示数据
  useEffect(() => {
    let alive = true;
    createAdapter()
      .then((res) => {
        if (!alive) return;
        setAdapter(res.adapter);
        setSource(res.source);
        setMode(res.mode);
        setBootError(res.error || '');
        setReady(true);
      })
      .catch((err) => {
        if (!alive) return;
        setBootError(err?.message || '数据源初始化失败');
        setReady(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const wall = useWall({ adapter, ready, toast, likedIds, setLikedIds });
  const { load, setQ, sort, setSort, cat, setCat, reportTarget, clearReportTarget } = wall;

  // 首屏 + 筛选/排序/搜索变化时重载（搜索输入已在下方防抖）
  useEffect(() => {
    if (ready) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, adapter, cat, sort, wall.q]);

  const handleSearch = useCallback(
    (value) => {
      setQ(value);
    },
    [setQ]
  );

  const submitPost = useCallback(
    async ({ cat: postCat, body }) => {
      if (!adapter) return false;
      try {
        const res = await adapter.createPost({ cat: postCat, body });
        toast(
          res.status === 'pending'
            ? '已提交，等待审核通过后公开'
            : '已发布'
        );
        // 先审后发：新帖不会立刻出现在墙上，因此不重载首屏
        return true;
      } catch (err) {
        toast(err?.message || '发布失败，请稍后再试');
        return false;
      }
    },
    [adapter, toast]
  );

  const submitReport = useCallback(
    async (reason) => {
      if (!adapter || reportTarget == null) return false;
      try {
        await adapter.createReport(reportTarget, reason || '用户举报');
        toast('举报已提交，平台将尽快核查');
        return true;
      } catch (err) {
        toast(err?.message || '举报提交失败，请稍后再试');
        return false;
      }
    },
    [adapter, reportTarget, toast]
  );

  const submitFeedback = useCallback(
    async ({ cat: fbCat, body, contact }) => {
      if (!adapter || typeof adapter.sendFeedback !== 'function') {
        toast('当前模式不支持提交反馈');
        return false;
      }
      try {
        await adapter.sendFeedback({ cat: fbCat, body, contact });
        toast('反馈已收到，谢谢！');
        return true;
      } catch (err) {
        toast(err?.message || '反馈提交失败，请稍后再试');
        return false;
      }
    },
    [adapter, toast]
  );

  // 弹层开关保持引用稳定：避免每次渲染都重建回调，导致弹层副作用反复重跑
  const openComposer = useCallback(() => setComposerOpen(true), []);
  const closeComposer = useCallback(() => setComposerOpen(false), []);
  const openLegal = useCallback(() => setLegalOpen(true), []);
  const closeLegal = useCallback(() => setLegalOpen(false), []);
  const closeReport = useCallback(() => clearReportTarget(), [clearReportTarget]);
  const openFeedback = useCallback(() => setFeedbackOpen(true), []);
  const closeFeedback = useCallback(() => setFeedbackOpen(false), []);

  const dismissNotice = useCallback(() => {
    setNoticeSeen(true);
    markBetaNoticeSeen(gate.beta.version);
  }, [gate.beta.version]);

  const demoReset = useMemo(
    () => (typeof adapter?.reset === 'function' ? wall.resetDemo : null),
    [adapter, wall.resetDemo]
  );

  const sourceNote = SOURCE_NOTES[source] || SOURCE_NOTES.local;
  const notice = mode === 'api' && bootError ? `后端不可用：${bootError}` : '';

  // 调试/自动化探针：把当前数据源、门禁状态与墙上条数挂到 window，
  // 让 scripts/smoke.mjs / prod-e2e.mjs 能在无头浏览器里断言真实状态。
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.__WALL_DEBUG__ = {
      mode,
      source,
      ready,
      readyState: document.readyState,
      adapterKind: adapter?.kind || null,
      counts: { posts: wall.items.length, liked: likedIds.size },
      loading: wall.loading,
      error: wall.error,
      bootError,
      sheets: {
        composer: composerOpen,
        legal: legalOpen,
        report: reportTarget != null,
        reportTarget,
        feedback: feedbackOpen,
        notice: !noticeSeen,
      },
      gate: {
        enabled: gate.config.enabled,
        required: gate.required,
        verified: gate.verified,
        open: gate.open,
        inviteRequired: gate.inviteRequired,
        loading: gate.loading,
        // 题目只暴露数量，不暴露答案（服务端本来就不下发答案）
        challengeItems: gate.challenge?.items?.length || 0,
      },
      beta: {
        version: gate.beta.version,
        name: gate.beta.name,
        feedback: gate.beta.feedback,
        noticeVisible: !noticeSeen,
      },
    };
  }, [
    mode, source, ready, adapter, wall.items.length, wall.loading, wall.error,
    likedIds.size, bootError, composerOpen, legalOpen, reportTarget, feedbackOpen, noticeSeen, gate,
  ]);

  return (
    <>
      <BetaBanner
        beta={gate.beta}
        gateRequired={gate.required}
        gateVerified={gate.verified}
        onOpenNotice={() => {
          setNoticeSeen(false);
        }}
        onOpenFeedback={openFeedback}
        onOpenGate={gate.openSheet}
      />

      <TopNav
        sort={sort}
        onSort={setSort}
        onOpenComposer={openComposer}
        onOpenLegal={openLegal}
        siteName={SITE_NAME}
        schoolName={SCHOOL_NAME}
      />

      <main id="content">
        <section className="hero" data-od-id="hero">
          <div className="container hero-inner">
            <p className="eyebrow">校园匿名社区{SCHOOL_NAME ? ` · ${SCHOOL_NAME}` : ''}</p>
            <h1>
              把没说出口的话，
              <br />
              写在这里。
            </h1>
            <p className="lead">
              匿名发布你的表白、树洞、寻人与致谢。所有内容经审核后公开，请先阅读平台公约。
            </p>
            <p className="hero-note">
              <button className="textlink" type="button" onClick={openLegal}>
                阅读发布公约与免责声明
              </button>
            </p>

            <BetaNotice
              beta={gate.beta}
              visible={!noticeSeen}
              onOpenFeedback={openFeedback}
              onDismiss={dismissNotice}
            />

            {gate.required && !gate.verified && (
              <div className="verify-note" role="status">
                <span className="verify-dot" aria-hidden="true" />
                <span>
                  浏览无需验证；<strong>发布、评论、举报</strong>前需要输入内测邀请码并完成一次本地验证。
                </span>
                <button className="btn btn-secondary btn-sm" type="button" onClick={gate.openSheet}>
                  去验证
                </button>
              </div>
            )}
          </div>
        </section>

        <Toolbar
          cat={cat}
          onCat={setCat}
          q={wall.q}
          onQ={handleSearch}
          disabled={!ready}
        />

        <Wall wall={wall} toast={toast} />

        <section className="section cta" data-od-id="cta-strip">
          <div className="container cta-inner">
            <h2>想说的话，别让它过夜。</h2>
            <p className="lead">匿名、免费，提交后由管理员审核。</p>
            <button className="btn btn-primary" type="button" onClick={openComposer}>
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                width="15"
                height="15"
                aria-hidden="true"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
              发布告白
            </button>
          </div>
        </section>
      </main>

      <Footer
        siteName={SITE_NAME}
        beta={gate.beta}
        onOpenComposer={openComposer}
        onOpenLegal={openLegal}
        onOpenFeedback={openFeedback}
        source={source}
        sourceNote={sourceNote}
        demoReset={demoReset}
      />

      <TabBar onOpenComposer={openComposer} onOpenLegal={openLegal} />

      <ComposerSheet
        open={composerOpen}
        onClose={closeComposer}
        onSubmit={submitPost}
      />

      <ReportSheet
        open={reportTarget != null}
        onClose={closeReport}
        onSubmit={submitReport}
      />

      <FeedbackSheet
        open={feedbackOpen}
        onClose={closeFeedback}
        onSubmit={submitFeedback}
        beta={gate.beta}
      />

      <LegalSheet open={legalOpen} onClose={closeLegal} beta={gate.beta} />

      {notice && (
        <p className="sr-only" role="alert">{notice}</p>
      )}
    </>
  );
}

export default function App() {
  // 内测版只有一个 Provider：门禁（含内测版元信息）。
  // 身份/实名相关 Provider 已随实名功能一并移除。
  return (
    <ToastProvider>
      <GateProvider>
        <WallApp />
      </GateProvider>
    </ToastProvider>
  );
}
