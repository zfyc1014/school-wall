/**
 * 用户标识：**学校 → 头衔 → 等级**，顺序是产品要求，不能调换。
 *
 * 三种密度，用于不同空间：
 *   full    学校 · 头衔 · Lv.N   —— 用户主页、论坛主题、私信对方信息
 *   compact 学校 · 头衔          —— 列表行、聊天气泡上方（省略等级）
 *   title   头衔 · Lv.N          —— 空间里已经能看出学校时（论坛楼中楼）
 *   level   Lv.N                 —— 只够放一个数字（回复行）
 *
 * 任何一段为空都**跳过它和它的分隔符**，绝不留下悬空的「·」。
 */

export function UserBadge({ user, variant = 'full', className = '' }) {
  if (!user) return null;

  const school = String(user.school || '').trim();
  const title = user.title && user.title.name ? user.title : null;
  const level = Number(user.level) || 0;

  const parts = [];
  const push = (node, key) => parts.push(<span key={key} className="badge-part">{node}</span>);

  if (variant === 'full') {
    if (school) push(school, 'school');
    if (title) push(<span className="badge-title" style={title.color ? { color: title.color } : undefined}>{title.name}</span>, 'title');
    if (level > 0) push(<span className="badge-level">Lv.{level}</span>, 'level');
  } else if (variant === 'compact') {
    if (school) push(school, 'school');
    if (title) push(<span className="badge-title" style={title.color ? { color: title.color } : undefined}>{title.name}</span>, 'title');
  } else if (variant === 'title') {
    if (title) push(<span className="badge-title" style={title.color ? { color: title.color } : undefined}>{title.name}</span>, 'title');
    if (level > 0) push(<span className="badge-level">Lv.{level}</span>, 'level');
  } else if (variant === 'level') {
    if (level > 0) push(<span className="badge-level">Lv.{level}</span>, 'level');
  }

  if (!parts.length) return null;

  return (
    <span className={'badge ' + className}>
      {parts.map((node, index) => (
        <span key={index} className="badge-item">
          {index > 0 ? <span className="badge-sep" aria-hidden="true">·</span> : null}
          {node}
        </span>
      ))}
    </span>
  );
}

export default UserBadge;
