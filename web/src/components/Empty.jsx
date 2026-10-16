/** 空态 / 加载态 / 错误态：三件套收口在这里，避免每个页面各写一份。 */
export function Empty({ title, hint, action }) {
  return (
    <div className="empty">
      {title ? <h3>{title}</h3> : null}
      {hint ? <p className="meta">{hint}</p> : null}
      {action ? <div style={{ marginTop: 16 }}>{action}</div> : null}
    </div>
  );
}

export function Loading({ rows = 3 }) {
  return (
    <div className="stack" aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="card card-pad">
          <div className="skeleton" style={{ height: 14, width: '35%' }} />
          <div className="skeleton" style={{ height: 12, marginTop: 12, width: '90%' }} />
          <div className="skeleton" style={{ height: 12, marginTop: 8, width: '70%' }} />
        </div>
      ))}
      <span className="sr-only">加载中</span>
    </div>
  );
}

export function ErrorState({ message, onRetry }) {
  return (
    <div className="empty">
      <h3>没能加载出来</h3>
      <p className="meta">{message || '请检查网络后重试'}</p>
      {onRetry ? (
        <div style={{ marginTop: 16 }}>
          <button className="btn btn-secondary" type="button" onClick={onRetry}>重试</button>
        </div>
      ) : null}
    </div>
  );
}

export default Empty;
