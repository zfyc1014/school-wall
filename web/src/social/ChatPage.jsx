import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { navigate } from '../router.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { Avatar } from '../components/Avatar.jsx';
import { UserBadge } from '../components/UserBadge.jsx';
import { Empty, ErrorState, Loading } from '../components/Empty.jsx';
import { IconBack, IconSend } from '../components/icons.jsx';
import { formatClock } from '../lib/format.js';
import '../styles/social.css';

/**
 * 单聊（#/messages/:uuid）。
 *
 * 同步策略：进入时拉第一页，之后每 5 秒**重拉第一页**。
 * 服务端的 nextCursor 是「更早的消息」的游标（keyset 按 id 倒序翻页），
 * 不是增量游标；用它做增量会和「自己刚发出去的消息」抢状态，得不偿失。
 * 重拉第一页 + 按 id 去重合并，既简单又不会丢消息。
 *
 * 本地的乐观气泡单独放一份（pending），和服务端数据分开，
 * 这样轮询覆盖 items 时不会把「正在发送」的那条一起抹掉。
 */

const MAX_LEN = 500;
const POLL_MS = 5000;

/** 按 id 合并去重并保持时间正序：轮询结果、乐观消息、更早的历史都走这里 */
function mergeById(prev, incoming) {
  const map = new Map();
  prev.forEach((m) => { if (m && m.id != null) map.set(m.id, m); });
  incoming.forEach((m) => { if (m && m.id != null) map.set(m.id, m); });
  return Array.from(map.values()).sort((a, b) => Number(a.id) - Number(b.id));
}

/** 触屏设备（软键盘的回车 = 换行）。判 primary pointer，触屏笔记本插鼠标时仍算 fine */
function isCoarsePointer() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: coarse)').matches;
}

function Bubble({ message, peer, me }) {
  const mine = Boolean(message.mine);
  return (
    <div className={'social-row' + (mine ? ' is-mine' : '')}>
      <Avatar user={mine ? me : peer} size={34} className="social-row-avatar" />
      <div className="social-bubble-wrap">
        <div className={'social-bubble' + (mine ? ' is-mine' : '') + (message.pending ? ' is-pending' : '')}>
          {message.body}
        </div>
        <span className="social-time">
          {message.pending ? '发送中…' : formatClock(message.createdAt)}
        </span>
      </div>
    </div>
  );
}

export function ChatPage({ uuid }) {
  const { user, ready, requireLogin, openAuth } = useAuth();
  const toast = useToast();
  const myUuid = user ? user.uuid : '';

  const [peer, setPeer] = useState(null);
  const [items, setItems] = useState([]);      // 最新一页（时间正序）
  const [older, setOlder] = useState([]);      // 手动加载的更早历史
  const [cursor, setCursor] = useState(null);  // 更早历史的游标；null = 没有更早的了
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [status, setStatus] = useState('loading'); // loading | ready | error | idle
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState([]);   // 乐观气泡：{key, body}
  const [blocked, setBlocked] = useState(null); // {code, message}：非好友 / 被拉黑
  const [addingFriend, setAddingFriend] = useState(false);

  const aliveRef = useRef(false);
  const seqRef = useRef(0);
  const firstScrollRef = useRef(true);
  const anchorRef = useRef(null);   // 「加载更早」前后的滚动锚点
  const endRef = useRef(null);      // 底部哨兵：滚到它就等于滚到最后一条
  const inputRef = useRef(null);

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!uuid) return;
    if (!silent) {
      setStatus('loading');
      setError('');
    }
    try {
      const data = await api.dm.thread(uuid);
      if (!aliveRef.current) return;
      setPeer(data && data.peer ? data.peer : null);
      const list = Array.isArray(data && data.items) ? data.items : [];
      setItems((prev) => (silent ? mergeById(prev, list) : list));
      if (!silent) setCursor(data ? data.nextCursor : null);
      setStatus('ready');
    } catch (err) {
      // 轮询失败不打断已经渲染出来的对话；首次加载失败才给错误页 + 重试
      if (silent || !aliveRef.current) return;
      setError((err && err.message) || '加载失败');
      setStatus('error');
    }
  }, [uuid]);

  useEffect(() => {
    if (!ready) return undefined;
    if (!uuid || !myUuid) {
      setStatus('idle');
      return undefined;
    }

    aliveRef.current = true;
    firstScrollRef.current = true; // 换人聊天时重新「首次到底」
    setItems([]);
    setOlder([]);
    setCursor(null);
    setBlocked(null);
    setPending([]);
    load();

    const timer = setInterval(() => {
      // 页面在后台时不发请求：手机锁屏状态下每 5 秒一个请求纯属浪费电和配额
      if (!document.hidden) load({ silent: true });
    }, POLL_MS);

    const onVisible = () => {
      if (!document.hidden) load({ silent: true });
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      aliveRef.current = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [ready, uuid, myUuid, load]);

  /* ── 滚动 ── */
  const scrollToBottom = useCallback((smooth) => {
    const node = endRef.current;
    if (!node) return;
    node.scrollIntoView({ block: 'end', behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  const lastId = items.length ? items[items.length - 1].id : 0;
  useEffect(() => {
    if (status !== 'ready') return;
    // 首次进入直接到底（不要动画，从顶部滑 30 条很晕）；新消息才平滑滚动
    scrollToBottom(!firstScrollRef.current);
    firstScrollRef.current = false;
  }, [status, lastId, pending.length, scrollToBottom]);

  /* ── 更早的历史 ── */
  const loadOlder = useCallback(async () => {
    if (!cursor || loadingOlder) return;
    setLoadingOlder(true);
    anchorRef.current = { height: document.documentElement.scrollHeight, top: window.scrollY };
    try {
      const data = await api.dm.thread(uuid, { cursor });
      const list = Array.isArray(data && data.items) ? data.items : [];
      setOlder((prev) => mergeById(prev, list));
      setCursor(data ? data.nextCursor : null);
    } catch (err) {
      anchorRef.current = null;
      toast((err && err.message) || '加载失败');
    } finally {
      setLoadingOlder(false);
    }
  }, [cursor, loadingOlder, uuid, toast]);

  // 往上面补历史时把视口「钉」在原处，否则内容会突然往下跳
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    anchorRef.current = null;
    const grown = document.documentElement.scrollHeight - anchor.height;
    if (grown > 0) window.scrollTo(0, anchor.top + grown);
  }, [older]);

  /* ── 发送 ── */
  const submit = useCallback(() => {
    const body = String(text || '').trim();
    if (!body || sending) return;
    if (body.length > MAX_LEN) {
      toast('单条私信最多 ' + MAX_LEN + ' 个字');
      return;
    }

    requireLogin(async () => {
      const key = 'pending-' + (seqRef.current += 1);
      setSending(true);
      setText('');
      setPending((list) => list.concat([{ key, body }])); // 先上屏，再等网络
      try {
        const res = await api.dm.send(uuid, body);
        setItems((prev) => mergeById(prev, [{
          id: res && res.id,
          body,
          mine: true,
          createdAt: (res && res.createdAt) || Date.now()
        }]));
        setPending((list) => list.filter((m) => m.key !== key));
      } catch (err) {
        setPending((list) => list.filter((m) => m.key !== key));
        // 失败把草稿放回输入框：让用户重打一遍是最容易被骂的失败体验
        setText((prev) => (prev ? prev : body));
        toast((err && err.message) || '发送失败');
        if (err && (err.code === 'not_friends' || err.code === 'blocked')) {
          setBlocked({ code: err.code, message: err.message });
        }
      } finally {
        setSending(false);
      }
    });
  }, [text, sending, uuid, requireLogin, toast]);

  const onKeyDown = useCallback((event) => {
    if (event.key !== 'Enter') return;
    // 中文输入法选词时的回车不算发送，否则永远打不出第一个词
    if (event.nativeEvent && event.nativeEvent.isComposing) return;
    // 移动端回车=换行：聊天里换行比发送常用，发送交给右边的按钮
    if (isCoarsePointer()) return;
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    submit();
  }, [submit]);

  // 输入框随内容长高（最多 4 行左右），一行高度写长句子很难受
  useLayoutEffect(() => {
    const node = inputRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = Math.min(node.scrollHeight, 112) + 'px';
  }, [text, blocked]);

  /* ── 加好友（非好友/被拉黑时提示条上的动作） ── */
  const addFriend = useCallback(() => {
    requireLogin(async () => {
      setAddingFriend(true);
      try {
        const res = await api.friends.request(uuid);
        if (res && res.status === 'accepted') {
          toast('你们已成为好友');
          setBlocked(null);
        } else {
          toast('已发送好友请求');
        }
      } catch (err) {
        toast((err && err.message) || '发送失败');
      } finally {
        setAddingFriend(false);
      }
    });
  }, [requireLogin, toast, uuid]);

  const all = mergeById(older, items);
  const showThread = ready && user && status === 'ready';

  return (
    <>
      <header className="page-head">
        <button
          className="btn-icon social-icon-btn"
          type="button"
          aria-label="返回私信列表"
          onClick={() => navigate('/messages')}
        >
          <IconBack size={20} />
        </button>
        <button
          className="social-peer social-head-title"
          type="button"
          onClick={() => navigate('/u/' + uuid)}
          title="查看主页"
        >
          <span className="social-peer-name truncate">{peer ? peer.nickname : '聊天'}</span>
          <UserBadge user={peer} variant="compact" className="social-badge" />
        </button>
        <span className="page-head-spacer" aria-hidden="true" />
      </header>

      <div className="container social-chat">
        <div className="social-thread-area">
          {!ready ? <Loading rows={3} /> : null}

          {ready && !user ? (
            <Empty
              title="登录后查看私信"
              hint="登录后就能和好友聊天"
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

          {showThread ? (
            <>
              {cursor ? (
                <div className="social-older">
                  <button
                    className="btn btn-ghost social-tap"
                    type="button"
                    onClick={loadOlder}
                    disabled={loadingOlder}
                  >
                    {loadingOlder ? '加载中…' : '查看更早的消息'}
                  </button>
                </div>
              ) : null}

              {!all.length && !pending.length ? (
                <Empty
                  title="还没有消息"
                  hint={peer ? '和 ' + (peer.nickname || '对方') + ' 打个招呼吧' : '打个招呼吧'}
                />
              ) : (
                <div className="social-thread">
                  {all.map((m) => <Bubble key={m.id} message={m} peer={peer} me={user} />)}
                  {pending.map((m) => (
                    <Bubble key={m.key} message={{ body: m.body, mine: true, pending: true }} peer={peer} me={user} />
                  ))}
                  <div ref={endRef} className="social-thread-end" aria-hidden="true" />
                </div>
              )}
            </>
          ) : null}
        </div>

        {showThread ? (
          blocked ? (
            <div className="social-hintbar glass">
              <span className="social-hintbar-text">{blocked.message || '只有好友之间才能私信'}</span>
              <button
                className="btn btn-primary social-tap"
                type="button"
                onClick={addFriend}
                disabled={addingFriend}
              >
                {addingFriend ? '发送中…' : '加好友'}
              </button>
            </div>
          ) : (
            <form
              className="social-composer glass"
              onSubmit={(event) => { event.preventDefault(); submit(); }}
            >
              <div className="social-composer-row">
                <textarea
                  ref={inputRef}
                  className="social-input"
                  rows={1}
                  value={text}
                  maxLength={MAX_LEN}
                  placeholder={peer ? '发消息给 ' + (peer.nickname || '对方') : '说点什么…'}
                  aria-label="消息内容"
                  onChange={(event) => setText(event.target.value)}
                  onKeyDown={onKeyDown}
                />
                <button
                  className="btn btn-primary social-send"
                  type="submit"
                  aria-label="发送"
                  disabled={sending || !text.trim()}
                >
                  <IconSend size={18} />
                </button>
              </div>
              {text.length >= 400 ? <div className="social-count">{text.length} / {MAX_LEN}</div> : null}
            </form>
          )
        ) : null}
      </div>
    </>
  );
}

export default ChatPage;
