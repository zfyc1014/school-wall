import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { navigate } from '../router.jsx';
import { Avatar, AVATAR_KEYS } from '../components/Avatar.jsx';
import { UserBadge } from '../components/UserBadge.jsx';
import { Empty, Loading } from '../components/Empty.jsx';
import { IconBack, IconSchool } from '../components/icons.jsx';
import { timeAgo } from '../lib/format.js';

/**
 * 账号个性化。
 *
 * 能改的只有三样：昵称、头像、简介。
 * **学校不在这里** —— 它在注册时选定且不可更改（服务端 PATCH /api/me 也不接受该字段），
 * 这里只做只读展示，并说明原因，免得用户到处找。
 * 头衔与等级同理：由后台/经验决定，用户改不了。
 */
export function SettingsPage() {
  const { user, ready, updateUser, openAuth } = useAuth();
  const toast = useToast();
  const [nickname, setNickname] = useState('');
  const [bio, setBio] = useState('');
  const [avatar, setAvatar] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!user) return;
    setNickname(user.nickname || '');
    setBio(user.bio || '');
    setAvatar(user.avatar || '');
  }, [user]);

  if (!ready) return <div className="container" style={{ paddingTop: 24 }}><Loading rows={2} /></div>;
  if (!user) {
    return (
      <div className="container" style={{ paddingTop: 24 }}>
        <Empty title="还没有登录" action={<button className="btn btn-primary" type="button" onClick={openAuth}>登录</button>} />
      </div>
    );
  }

  const cooldownUntil = Number(user.nicknameCooldownUntil) || 0;
  const cooldownLeft = Math.max(0, cooldownUntil - Date.now());
  const nicknameLocked = cooldownLeft > 0 && nickname.trim() !== user.nickname;

  const save = async () => {
    setBusy(true);
    try {
      const result = await api.me.update({ nickname: nickname.trim(), bio: bio.trim(), avatar });
      updateUser(result.user);
      toast('已保存');
    } catch (err) {
      toast(err.message || '保存失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="container">
      <div className="page-head">
        <div className="container row" style={{ width: '100%', paddingInline: 0 }}>
          <button className="btn-icon" type="button" aria-label="返回" onClick={() => navigate('/me')}>
            <IconBack size={20} />
          </button>
          <span className="page-title">编辑资料</span>
        </div>
      </div>

      <section className="card card-pad" style={{ marginTop: 12 }}>
        <div className="row" style={{ gap: 14 }}>
          <Avatar user={{ ...user, avatar }} size={56} />
          <div className="grow">
            <strong>{nickname || user.nickname}</strong>
            <UserBadge user={{ ...user, nickname }} variant="full" />
          </div>
        </div>

        <span className="field-label" style={{ display: 'block', marginTop: 18 }}>头像</span>
        <div className="auth-avatars" style={{ marginTop: 8 }}>
          <button
            type="button"
            className={'auth-avatar' + (avatar === '' ? ' is-active' : '')}
            onClick={() => setAvatar('')}
            aria-label="默认头像"
          >
            <Avatar user={{ ...user, avatar: '' }} size={44} />
          </button>
          {AVATAR_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              className={'auth-avatar' + (avatar === key ? ' is-active' : '')}
              onClick={() => setAvatar(key)}
              aria-label={'头像 ' + key}
            >
              <Avatar user={{ ...user, avatar: key }} size={44} />
            </button>
          ))}
        </div>
      </section>

      <section className="card card-pad" style={{ marginTop: 16 }}>
        <div className="field">
          <label className="field-label" htmlFor="set-nickname">昵称（{nickname.length}/16）</label>
          <input
            id="set-nickname"
            className="input"
            maxLength={16}
            value={nickname}
            onChange={(event) => setNickname(event.target.value)}
          />
          <p className="meta">
            {nicknameLocked
              ? `昵称修改有冷却时间，${timeAgo(Date.now() - cooldownLeft)}后可再改`
              : '2–16 个字，会经过违禁词检查'}
          </p>
        </div>

        <div className="field" style={{ marginTop: 16 }}>
          <label className="field-label" htmlFor="set-bio">简介（{bio.length}/60）</label>
          <input
            id="set-bio"
            className="input"
            maxLength={60}
            placeholder="一句话介绍自己"
            value={bio}
            onChange={(event) => setBio(event.target.value)}
          />
        </div>

        <button
          className="btn btn-primary btn-block"
          style={{ marginTop: 20 }}
          type="button"
          disabled={busy || nickname.trim().length < 2}
          onClick={save}
        >
          {busy ? '保存中…' : '保存'}
        </button>
      </section>

      <section className="list" style={{ marginTop: 16 }}>
        <div className="list-item" style={{ cursor: 'default' }}>
          <IconSchool size={20} />
          <div className="grow">
            <div>学校</div>
            <div className="meta">注册时选定，不可更改</div>
          </div>
          <strong>{user.school}</strong>
        </div>
        <div className="list-item" style={{ cursor: 'default' }}>
          <span className="grow">头衔与等级</span>
          <UserBadge user={user} variant="title" />
        </div>
        <div className="list-item" style={{ cursor: 'default' }}>
          <span className="grow">邮箱</span>
          <span className="meta">{user.email}</span>
        </div>
      </section>
    </div>
  );
}

export default SettingsPage;
