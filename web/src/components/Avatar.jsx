import { useMemo } from 'react';

/**
 * 头像。
 *
 * 本站不做图片上传（校园产品里用户头像是最容易出事的上传口之一：
 * 涉黄、涉政、真人照片都在这里出现，且需要存储与审核成本）。
 * 因此头像是一组**预设图形 + 由 uuid 派生的稳定配色**：
 * 每个人长得都不一样，且永远不需要审核。
 */

const PALETTE = [
  ['#0071e3', '#5ac8fa'], ['#ff375f', '#ff9f0a'], ['#30d158', '#0aa2c0'],
  ['#bf5af2', '#5e5ce6'], ['#ff9f0a', '#ffd60a'], ['#0aa2c0', '#30d158'],
  ['#5e5ce6', '#bf5af2'], ['#ff6482', '#ff375f']
];

/** 由 uuid 稳定派生色号：同一个人在任何设备上都是同一个颜色 */
function pairFor(seed) {
  const text = String(seed || '');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) % 100000;
  }
  return PALETTE[hash % PALETTE.length];
}

const GLYPH = {
  leaf: '叶', moon: '月', star: '星', cloud: '云', cat: '猫', fox: '狐', whale: '鲸',
  sakura: '樱', book: '书', coffee: '咖', music: '乐', camera: '影', rocket: '箭',
  ball: '球', rain: '雨', sun: '日'
};

/** 可选头像 key 列表：注册页与设置页共用（服务端也有同一份白名单做校验） */
export const AVATAR_KEYS = Object.keys(GLYPH);

export function Avatar({ user, size = 40, className = '' }) {
  const seed = (user && (user.uuid || user.nickname)) || 'anonymous';
  const [from, to] = useMemo(() => pairFor(seed), [seed]);
  const glyph = GLYPH[(user && user.avatar) || ''] || '同';
  const name = (user && user.nickname) || '匿名同学';

  return (
    <span
      className={'avatar ' + className}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
        background: `linear-gradient(140deg, ${from}, ${to})`
      }}
      aria-label={name}
      role="img"
    >
      {glyph}
    </span>
  );
}

export default Avatar;
