/**
 * 极简 Markdown 渲染（零依赖）。
 *
 * 为什么自己写而不引库：本站前端只依赖 React，为「首页一块介绍文字」引一个
 * markdown 库（+ 清洗库）不值得 —— 打包体积和供应链风险都划不来。
 *
 * 安全第一：**先整体转义 HTML，再做语法替换**，所以输出里不可能出现用户传入的标签；
 * 链接还会再校验一次协议（只允许 http/https/mailto 与站内相对路径），
 * 避免 javascript: 这类伪协议。
 *
 * 支持：标题(#~######) / 加粗 / 斜体 / 行内代码 / 代码块 / 链接 / 有序无序列表 /
 *       引用 / 分隔线 / 段落 / 换行。
 */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function safeHref(raw) {
  const url = String(raw || "").trim();
  if (!url) return "";
  if (url.startsWith("/") || url.startsWith("#")) return url;
  if (/^https?:\/\//i.test(url)) return url;
  if (/^mailto:[^\s@]+@[^\s@]+$/i.test(url)) return url;
  return ""; // 其它协议（javascript: / data: …）一律丢弃
}

function inline(text) {
  let out = text;
  // 行内代码先占位，避免里面的 * _ 被当成强调
  const codes = [];
  out = out.replace(/`([^`\n]+)`/g, (m, code) => {
    codes.push(code);
    return "\u0000CODE" + (codes.length - 1) + "\u0000";
  });
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, ""); // 不支持图片：避免外链追踪与加载失败
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
    const safe = safeHref(href);
    return safe ? '<a href="' + escapeHtml(safe) + '" target="_blank" rel="noreferrer noopener">' + label + "</a>" : label;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/(^|[^_])__([^_]+)__/g, "$1<strong>$2</strong>");
  out = out.replace(/\u0000CODE(\d+)\u0000/g, (m, i) => "<code>" + escapeHtml(codes[Number(i)]) + "</code>");
  return out;
}

export function renderMarkdown(src) {
  const text = String(src == null ? "" : src).replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
  const lines = escapeHtml(text).split("\n");
  const html = [];
  let i = 0;

  const flushParagraph = (buf) => {
    if (!buf.length) return;
    html.push("<p>" + buf.map(inline).join("<br>") + "</p>");
    buf.length = 0;
  };
  const para = [];

  while (i < lines.length) {
    const line = lines[i];

    // 代码块
    const fence = /^```(.*)$/.exec(line);
    if (fence) {
      flushParagraph(para);
      const lang = fence[1].trim();
      const code = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { code.push(lines[i]); i += 1; }
      i += 1;
      html.push(
        '<pre class="md-pre"' + (lang ? ' data-lang="' + escapeHtml(lang) + '"' : "") + "><code>"
        + code.join("\n") + "</code></pre>"
      );
      continue;
    }

    // 空行
    if (!line.trim()) { flushParagraph(para); i += 1; continue; }

    // 分隔线
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph(para); html.push("<hr>"); i += 1; continue;
    }

    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushParagraph(para);
      const level = h[1].length;
      html.push("<h" + level + ">" + inline(h[2].replace(/\s+#+\s*$/, "")) + "</h" + level + ">");
      i += 1;
      continue;
    }

    // 引用（连续的 > 行合并成一个 blockquote）
    if (/^&gt;\s?/.test(line)) {
      flushParagraph(para);
      const quote = [];
      while (i < lines.length && /^&gt;\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^&gt;\s?/, ""));
        i += 1;
      }
      html.push("<blockquote>" + quote.map(inline).join("<br>") + "</blockquote>");
      continue;
    }

    // 列表（连续同类行合并）
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushParagraph(para);
      const ordered = Boolean(ol);
      const items = [];
      while (i < lines.length) {
        const m = ordered
          ? /^\s*\d+[.)]\s+(.*)$/.exec(lines[i])
          : /^\s*[-*+]\s+(.*)$/.exec(lines[i]);
        if (!m) break;
        items.push("<li>" + inline(m[1]) + "</li>");
        i += 1;
      }
      html.push((ordered ? "<ol>" : "<ul>") + items.join("") + (ordered ? "</ol>" : "</ul>"));
      continue;
    }

    para.push(line);
    i += 1;
  }
  flushParagraph(para);
  return html.join("\n");
}

export default renderMarkdown;
