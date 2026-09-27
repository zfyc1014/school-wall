/**
 * @typedef {'表白'|'树洞'|'寻人'|'失物'|'致谢'} PostCategory
 * @typedef {{ id: string|number, cat: PostCategory, body: string, likes: number, liked: boolean, comments: number, createdAt: number }} Post
 * @typedef {{ id: string|number, who: string, text: string, createdAt?: number }} Comment
 * @typedef {'auto'|'api'|'local'} DataMode
 * @typedef {'api'|'local'|'fallback'} ActiveSource
 * @typedef {{ items: Post[], nextCursor: string|null, sort: 'new'|'hot' }} FeedPage
 * @typedef {{ id: string|number, status: 'pending'|'approved'|'rejected'|'removed' }} CommentResult
 */

export const CATS = ['全部', '表白', '树洞', '寻人', '失物', '致谢'];

/** 可选择分类（不含「全部」，与后端 cleanCat 白名单一致） */
export const POST_CATS = ['表白', '树洞', '寻人', '失物', '致谢'];

export const BODY_MIN = 6;
export const BODY_MAX = 500;
export const COMMENT_MAX = 120;
export const PAGE_SIZE = 20;

/** 契约：匿名仅指前台不展示身份 */
export const ANON_NAME = '匿名同学';
export const ANON_AVATAR = '匿';
