/**
 * 演示种子数据 —— 迁移自 school-confession-wall.html 的 seedPosts()。
 * 时间戳在模块加载时按「相对现在」生成，因此无论何时打开都呈现
 * 「12 分钟前 / 46 分钟前 / 2 小时前」这套节奏，不会出现 2026 年固定日期。
 */
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const BASE = Date.now();

/** @returns {import('./types.js').Post[]} */
export function seedPosts() {
  return [
    {
      id: 'p1', cat: '表白', createdAt: BASE - 12 * MIN, likes: 1284, liked: false,
      body: '想对每天在三教 302 靠窗第二排的女生说：你低头写字的样子，让我整个春天都没能好好听课。如果你看到这条，周三下午图书馆老位置，我会照旧带两杯热可可坐在那边。',
      comments: [
        { id: 'c1', who: '匿名', text: '这也太浪漫了，冲！' },
        { id: 'c2', who: '匿名', text: '302 常客路过，祝好运。' },
      ],
    },
    {
      id: 'p2', cat: '树洞', createdAt: BASE - 46 * MIN, likes: 306, liked: false,
      body: '大一到现在，第一次觉得一个人吃饭其实也没那么难。谢谢食堂二楼的阿姨，每次都悄悄多给我一勺菜。',
      comments: [],
    },
    {
      id: 'p3', cat: '寻人', createdAt: BASE - 2 * HOUR, likes: 189, liked: false,
      body: '找一个上周五傍晚在操场帮我捡回学生卡的男生。你只说了一句「下次别跑那么急」就走了。如果你看到这条，想请你喝一杯奶茶当面道谢。',
      comments: [{ id: 'c3', who: '匿名', text: '操场傍晚人太多了，帮你顶一下。' }],
    },
    {
      id: 'p4', cat: '致谢', createdAt: BASE - 5 * HOUR, likes: 142, liked: false,
      body: '谢谢那位在图书馆闭馆前，把《小王子》轻轻塞回我书包的同学。我赶末班校车差点把它忘在桌上，那本书是别人送我的礼物。',
      comments: [],
    },
    {
      id: 'p5', cat: '失物', createdAt: BASE - 9 * HOUR, likes: 64, liked: false,
      body: '在南门共享单车车筐里捡到一只蓝色保温杯，杯身贴着星黛露贴纸，已交到南门保安室。失主可以凭杯盖上的划痕认领。',
      comments: [{ id: 'c4', who: '匿名', text: '好像是我室友的，我让她去看看！' }],
    },
    {
      id: 'p6', cat: '表白', createdAt: BASE - 1 * DAY, likes: 2310, liked: false,
      body: '辩论队决赛那天，你在台下举着写错字的灯牌，我居然一点都不觉得丢人，反而想认识你。如果你也记得那个错字，请来联系我。',
      comments: [
        { id: 'c5', who: '匿名', text: '灯牌错字这个细节绝了。' },
        { id: 'c6', who: '匿名', text: '祝双向奔赴。' },
      ],
    },
    {
      id: 'p7', cat: '树洞', createdAt: BASE - 1.4 * DAY, likes: 512, liked: false,
      body: '期末周在天台背书，风很大，书页翻得比我快。突然觉得，好像也没那么孤单。',
      comments: [],
    },
    {
      id: 'p8', cat: '致谢', createdAt: BASE - 2.2 * DAY, likes: 97, liked: false,
      body: '谢谢在末班校车上给抱着一摞实验器材的我让座的学弟。你没说话就站起来了，我到站才反应过来没来得及道谢。',
      comments: [],
    },
  ];
}
