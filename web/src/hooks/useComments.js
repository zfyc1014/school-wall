import { useCallback, useEffect, useRef, useState } from 'react';
import { COMMENT_MAX } from '../lib/types.js';

/**
 * 评论面板：首次展开才拉取（对应 GET /api/posts/:id/comments），
 * 提交后按后端返回的 status 决定是否需要审核提示。
 *
 * @param {object} options
 * @param {boolean} options.open
 * @param {any} options.adapter
 * @param {string|number} options.postId
 * @param {(msg: string) => void} options.toast
 * @param {(count: number) => void} options.onCountChange
 */
export function useComments({ open, adapter, postId, toast, onCountChange }) {
  const [comments, setComments] = useState([]);
  const [state, setState] = useState('idle'); // idle | loading | ready | error
  const [sending, setSending] = useState(false);
  const loadedOnce = useRef(false);
  const postIdRef = useRef(postId);

  useEffect(() => {
    postIdRef.current = postId;
    loadedOnce.current = false;
    setComments([]);
    setState('idle');
  }, [postId]);

  useEffect(() => {
    if (!open || loadedOnce.current || !adapter) return undefined;
    let alive = true;
    loadedOnce.current = true;
    setState('loading');
    adapter
      .listComments(postId)
      .then((list) => {
        if (!alive) return;
        setComments(list);
        setState('ready');
        onCountChange?.(list.length);
      })
      .catch(() => {
        if (!alive) return;
        loadedOnce.current = false;
        setState('error');
      });
    return () => {
      alive = false;
    };
    // onCountChange 由父级 useCallback 稳定，postId/open 变化才重新拉取
  }, [open, adapter, postId, onCountChange]);

  const submit = useCallback(
    async (text) => {
      const body = text.trim();
      if (!body || sending) return false;
      setSending(true);
      try {
        const res = await adapter.createComment(postIdRef.current, body.slice(0, COMMENT_MAX));
        if (res.status === 'approved') {
          const local = { id: res.id, who: '匿名', text: body, createdAt: Date.now() };
          setComments((prev) => {
            const next = [...prev, local];
            onCountChange?.(next.length);
            return next;
          });
        } else {
          // 内测版与帖子同口径：评论**一律先审后发**（不再是「命中规则才转人工」），
          // 因此这里的提示不能再说「因为含联系方式」—— 那句话会让人误以为
          // 没写联系方式的评论会直接公开。
          toast('评论已提交，审核通过后公开');
        }
        return true;
      } catch (err) {
        toast(err?.message || '评论发送失败');
        return false;
      } finally {
        setSending(false);
      }
    },
    [adapter, onCountChange, sending, toast]
  );

  return { comments, state, sending, submit, maxLength: COMMENT_MAX };
}
