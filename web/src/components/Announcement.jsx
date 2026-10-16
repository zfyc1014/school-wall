import { useState } from 'react';
import { navigate } from '../router.jsx';
import { IconBell } from './icons.jsx';

/**
 * 首页公告栏。
 *
 * 内容全部来自后台（GET /api/site），前端不硬编码任何一条文案。
 * 默认只显示最新一条 —— 首页要「尽量少留信息」；有多条时才出现「查看全部」。
 * 链接只允许站内路径（服务端已经过滤过 javascript: 之类）。
 */
export function Announcement({ items = [] }) {
  const [expanded, setExpanded] = useState(false);
  if (!items.length) return null;

  const list = expanded ? items : items.slice(0, 1);

  return (
    <div className="announce" role="status">
      <span className="announce-icon"><IconBell size={16} /></span>
      <div className="announce-body">
        {list.map((item) => (
          <div key={item.id}>
            <span>{item.body}</span>
            {item.link ? (
              <a
                className="announce-link"
                href={item.link.startsWith('/') ? '#' + item.link : item.link}
                target={item.link.startsWith('/') ? undefined : '_blank'}
                rel="noreferrer"
                onClick={(event) => {
                  if (!item.link.startsWith('/')) return;
                  event.preventDefault();
                  navigate(item.link);
                }}
              >
                {item.linkText || '查看'}
              </a>
            ) : null}
          </div>
        ))}
        {items.length > 1 ? (
          <button className="announce-more" type="button" onClick={() => setExpanded((v) => !v)}>
            {expanded ? '收起' : `查看全部 ${items.length} 条`}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default Announcement;
