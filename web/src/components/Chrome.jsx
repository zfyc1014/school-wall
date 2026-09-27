import { CATS } from '../lib/types.js';
import { IconSearch } from './icons.jsx';

/** 吸顶工具条：分类 chips + 关键词搜索（当前为纯展示视图，暂无跨视图导航） */
export function Toolbar({ cat, onCat, q, onQ, disabled }) {
  return (
    <div className="toolbar" data-od-id="toolbar">
      <div className="container toolbar-inner">
        <div className="chips" role="group" aria-label="分类筛选">
          {CATS.map((c) => (
            <button
              key={c}
              className="chip"
              type="button"
              aria-pressed={cat === c}
              onClick={() => onCat(c)}
            >
              {c}
            </button>
          ))}
        </div>
        <div className="right">
          <label className="search">
            <IconSearch />
            <input
              type="search"
              placeholder="搜索关键词"
              aria-label="搜索帖子"
              value={q}
              disabled={disabled}
              onChange={(e) => onQ(e.target.value)}
            />
          </label>
        </div>
      </div>
    </div>
  );
}

/** 顶栏：品牌 + 最新/最热分段控件 + 发布入口 */
export function TopNav({ sort, onSort, onOpenComposer, onOpenLegal, siteName, schoolName }) {
  return (
    <header className="topnav" data-od-id="topnav">
      <div className="container topnav-inner">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">墙</span>
          <span className="brand-name">{siteName}</span>
          <span className="brand-tag meta">· {schoolName}</span>
        </div>

        <div className="navseg" role="tablist" aria-label="浏览方式">
          <button
            type="button"
            role="tab"
            aria-selected={sort === 'new'}
            onClick={() => onSort('new')}
          >
            最新
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={sort === 'hot'}
            onClick={() => onSort('hot')}
          >
            最热
          </button>
        </div>

        <div className="nav-actions">
          <button className="btn btn-ghost" type="button" onClick={onOpenLegal}>
            发布公约
          </button>
          <button className="btn btn-primary" type="button" onClick={onOpenComposer}>
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
      </div>
    </header>
  );
}
