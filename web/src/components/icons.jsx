/**
 * 图标：全部内联 SVG，统一 24 视窗 + currentColor 描边。
 * 不引图标库 —— 整站只用到十几个图标，一个依赖换不来什么。
 * 尺寸由 props 控制（默认 22，跟随按钮字号时可传 18/16）。
 * 统一 aria-hidden，可访问名由外层按钮的 aria-label 提供。
 */

const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': 'true',
  focusable: 'false'
};

function Svg({ size = 22, strokeWidth = 1.7, children, ...rest }) {
  return <svg width={size} height={size} strokeWidth={strokeWidth} {...base} {...rest}>{children}</svg>;
}

export const IconHome = (p) => <Svg {...p}><path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z" /></Svg>;
export const IconForum = (p) => <Svg {...p}><path d="M4 5h16v11H9l-5 4z" /><path d="M8 9h8M8 12.5h5" /></Svg>;
export const IconChat = (p) => <Svg {...p}><path d="M21 12a8 8 0 0 1-8 8H8l-5 3 1.6-4.4A8 8 0 1 1 21 12z" /></Svg>;
export const IconUser = (p) => <Svg {...p}><circle cx="12" cy="8.5" r="3.6" /><path d="M4.5 20c1.2-3.6 4-5.5 7.5-5.5S18.3 16.4 19.5 20" /></Svg>;
export const IconPlus = (p) => <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>;
export const IconSearch = (p) => <Svg {...p}><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></Svg>;
export const IconHeart = ({ filled, ...p }) => (
  <Svg {...p} fill={filled ? 'currentColor' : 'none'}>
    <path d="M12 20s-7-4.4-7-9.4A3.9 3.9 0 0 1 12 8a3.9 3.9 0 0 1 7 2.6c0 5-7 9.4-7 9.4z" />
  </Svg>
);
export const IconComment = (p) => <Svg {...p}><path d="M20 12a7 7 0 0 1-7 7H9l-4 2.5.9-3.6A7 7 0 1 1 20 12z" /></Svg>;
export const IconBack = (p) => <Svg {...p}><path d="M15 5l-7 7 7 7" /></Svg>;
export const IconClose = (p) => <Svg {...p}><path d="M6 6l12 12M18 6 6 18" /></Svg>;
export const IconMore = (p) => <Svg {...p}><circle cx="5.5" cy="12" r="1.3" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" /><circle cx="18.5" cy="12" r="1.3" fill="currentColor" stroke="none" /></Svg>;
export const IconSend = (p) => <Svg {...p}><path d="M4.5 12 20 4.5 15 20l-3.4-6.1z" /><path d="m11.6 13.9 8.4-9.4" /></Svg>;
export const IconCheck = (p) => <Svg {...p}><path d="m5 13 4.5 4.5L19 7" /></Svg>;
export const IconLink = (p) => <Svg {...p}><path d="M10.5 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1 1" /><path d="M13.5 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1-1" /></Svg>;
export const IconBell = (p) => <Svg {...p}><path d="M18 15V10a6 6 0 1 0-12 0v5l-1.5 3h15z" /><path d="M10 20.5a2 2 0 0 0 4 0" /></Svg>;
// 滑杆而不是齿轮：齿轮图标在手机小尺寸下容易和「主题切换」混淆
export const IconSettings = (p) => <Svg {...p}><path d="M5 7h14M5 12h14M5 17h14" /><circle cx="9" cy="7" r="2" fill="var(--surface)" /><circle cx="15" cy="12" r="2" fill="var(--surface)" /><circle cx="8" cy="17" r="2" fill="var(--surface)" /></Svg>;
export const IconLock = (p) => <Svg {...p}><rect x="5" y="10.5" width="14" height="9.5" rx="2" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" /></Svg>;
export const IconTrash = (p) => <Svg {...p}><path d="M5 7h14M9.5 7V5h5v2M7 7l.9 12.1A1 1 0 0 0 8.9 20h6.2a1 1 0 0 0 1-.9L17 7" /></Svg>;
export const IconUserPlus = (p) => <Svg {...p}><circle cx="10" cy="8.5" r="3.4" /><path d="M3.8 20c1.1-3.3 3.5-5 6.2-5s5.1 1.7 6.2 5" /><path d="M18.5 7v5M21 9.5h-5" /></Svg>;
export const IconSchool = (p) => <Svg {...p}><path d="M12 4 2.5 8.5 12 13l9.5-4.5z" /><path d="M6 11v5.2c0 1.3 2.7 2.8 6 2.8s6-1.5 6-2.8V11" /></Svg>;
export const IconInfo = (p) => <Svg {...p}><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5.5M12 7.8v.4" /></Svg>;
export const IconFlag = (p) => <Svg {...p}><path d="M5 21V4h13l-2 4 2 4H5" /></Svg>;
export const IconBubble = IconComment;
