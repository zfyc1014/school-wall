/**
 * 单线条图标（与原型内联 SVG 逐字一致：24×24 viewBox、currentColor 描边）。
 * 统一 `aria-hidden`，可访问名由外层按钮的 aria-label 提供。
 */
const svgBase = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  'aria-hidden': 'true',
  focusable: 'false',
};

export function IconPlus({ width = 15, height = 15, strokeWidth = 1.8 }) {
  return (
    <svg {...svgBase} width={width} height={height} strokeWidth={strokeWidth}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function IconClose({ width = 17, height = 17 }) {
  return (
    <svg {...svgBase} width={width} height={height} strokeWidth={1.8}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function IconSearch({ width = 15, height = 15 }) {
  return (
    <svg {...svgBase} width={width} height={height} strokeWidth={1.8}>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.2-3.2" />
    </svg>
  );
}

export function IconHeart() {
  return (
    <svg {...svgBase} strokeWidth={1.7}>
      <path d="M12 20s-7-4.5-7-9.5A3.9 3.9 0 0 1 12 8a3.9 3.9 0 0 1 7 2.5C19 15.5 12 20 12 20z" />
    </svg>
  );
}

export function IconBubble() {
  return (
    <svg {...svgBase} strokeWidth={1.7}>
      <path d="M20 12a7 7 0 0 1-7 7H8l-4 3v-4.5A7 7 0 0 1 11 5h2a7 7 0 0 1 7 7z" />
    </svg>
  );
}

export function IconFlag() {
  return (
    <svg {...svgBase} strokeWidth={1.7}>
      <path d="M5 21V4h13l-2 4 2 4H5" />
    </svg>
  );
}

export function IconShield({ width = 16, height = 16, strokeWidth = 1.6 }) {
  return (
    <svg {...svgBase} width={width} height={height} strokeWidth={strokeWidth}>
      <path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z" />
      <path d="M9.5 12l1.8 1.8 3.7-4" />
    </svg>
  );
}

export function IconHouse({ width = 16, height = 16, strokeWidth = 1.6 }) {
  return (
    <svg {...svgBase} width={width} height={height} strokeWidth={strokeWidth}>
      <path d="M3 11l9-6 9 6v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M9 21v-6h6v6" />
    </svg>
  );
}

export function IconGrid({ width = 22, height = 22, strokeWidth = 1.7 }) {
  return (
    <svg {...svgBase} width={width} height={height} strokeWidth={strokeWidth}>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M3 9h18M9 9v11" />
    </svg>
  );
}
