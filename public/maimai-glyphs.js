/**
 * 官方结算素材拼字：CLEAR! / TRACK / 段位字母 / 大数字。
 *
 * 页面上这些原本是 CSS 画的花体字，形似但终归不是官方的。客户端里这几样都有现成精灵，
 * 尺寸和配色都是官方那套，这里只负责把格子拼成词，交给调用方塞进页面。
 *
 * 几个只看文件名读不出来的地方（都是对着抓图核过的）：
 *   · CLEAR! 是六个字母精灵，有 01/02/03 三套配色；抓图那套是 _01_（白字 + 蓝描边）
 *   · 段位没有 SS/SSS，是用 S 的颜色变体拼的：三个 S 就是 Blue/Red/Yellow
 *   · 大数字用分数那套金色精灵，格子号 0-9 是数字，10='+'、11='-'、12='/'、13='.'
 *   · '%' 是单独一张 UI_RSL_Score_Per_Gold
 */

import { platformLabel } from './problem-source.js';

const ASSETS = '/assets/mm-result/';
const RANK_LETTERS = new Set(['S', 'A', 'B', 'C', 'D']);

/** 大数字可选的四套配色，和客户端里的族名一致 */
export const NUMBER_COLOURS = ['Gold', 'Red', 'Blue', 'Base'];
/** 数字的两套图集：同一字体的两个尺寸，1110000 是大号 */
export const NUMBER_ATLASES = ['1110000', '0001111'];

/** 大数字的格子号：和 layout 里的编号一致 */
const DIGIT_CELL = { ...Object.fromEntries([...'0123456789'].map((c, i) => [c, i])), '+': 10, '-': 11, '/': 12, '.': 13 };

/**
 * 小数点的坑号**不是每族都一样**，这是逐族比字形才看出来的：
 * 0001111_Red 的 12/13 是反的（13 画的是逗号，12 才是小数点）。其余族都是 13。
 * 只影响小数点，数字 0~9 各族的坑号一致。
 */
const DOT_CELL = { Red: 12 };

function glyph(file, { className = '', height = '' } = {}) {
  const img = document.createElement('img');
  img.className = 'mm-glyph' + (className ? ' ' + className : '');
  img.src = ASSETS + file;
  img.alt = '';
  img.decoding = 'async';
  if (height) img.style.height = height;
  return img;
}

/** CLEAR! —— 六个字母精灵；抓图用的是 _01_ 那套配色 */
export function clearWord({ variant = '01' } = {}) {
  const word = document.createElement('span');
  word.className = 'mm-clear-word';
  for (let i = 1; i <= 6; i += 1) word.append(glyph(`UI_RSL_Text_Clear_${variant}_${String(i).padStart(2, '0')}.png`));
  return word;
}

/** TRACK —— 官方就一张图。prefab 里 UI_Track 是 93x30 抓图 = 112x36 原生，
    素材 UI_RSL_Text_TRACK 正好 110x36，所以是按原生尺寸贴的。 */
export function trackLabel() {
  const label = document.createElement('span');
  label.className = 'mm-track-label';
  label.append(glyph('UI_RSL_Text_TRACK.png'));
  return label;
}

/**
 * 达成率标题那一行 —— 用原版素材，不用页面自己拼的文字。
 *
 * 只画 UI_RSL_Text_Achievement（prefab: AchievementLogo，296x41，抓图 247x40）。
 * prefab 里还有一条 UI_RSL_Base_Achievement（Achievment_Base/Base_01，抓图 1667x107）
 * —— 那是 1667px 宽、比 903 的画面还宽的长条，本是溢出裁切的装饰底；
 * 整条铺进这一行会变成一大片空色（文字只占最左一点），看着就是"意义不明的色块"，
 * 所以不画它。
 */
export function achievementLabel() {
  const wrap = document.createElement('span');
  wrap.className = 'mm-achv-label';
  wrap.append(glyph('UI_RSL_Text_Achievement.png', { className: 'mm-glyph mm-achv-label-text' }));
  return wrap;
}

/**
 * 结算勋章：一块底座 + 两枚徽章。
 *
 * prefab（UI_MedalDisplay，capture 250x125@(144,553)）：
 *   Medal_Base            UI_RSL_MedalBase  326x153 原生 -> capture 273x130@(172,552)  底座
 *   v110   (左槽)          capture 83x83@(227,574)   ->  AP_Base/AP_Text_01
 *   Null_FS_FSD_Medal(右槽) capture 83x83@(318,574)   ->  FSD_Base/FSD_Text_01
 * 两槽间距 318-227 = 91 capture；槽相对底座左边 227-172 = 55 capture。
 * 整组中心 x=314，段位中心 x=292（差 22 capture ~ 26 原生），基本水平居中。
 */
export function medalPair({ cleanSolve = true } = {}) {
  const wrap = document.createElement('span');
  wrap.className = 'mm-medals';
  wrap.append(glyph('UI_RSL_MedalBase.png', { className: 'mm-glyph mm-medal-base' }));
  // 两枚圆片是 Codex 生图产出的（青绿 Accepted / 香槟金 Clean Solve），
  // 官方素材 UI_RSL_AP_* / UI_RSL_FSD_* 是分「底 + 字」两层、画风偏写实，
  // 这里按需求换成配套的一对圆章。
  const ap = document.createElement('img');
  ap.className = 'mm-medal mm-medal--ap';
  ap.src = '/assets/maimai/medal-accepted.png';
  ap.alt = 'Accepted';
  wrap.append(ap);
  const cs = document.createElement('img');
  cs.className = 'mm-medal mm-medal--fsd';
  cs.src = '/assets/maimai/medal-cleansolve.png';
  cs.alt = 'Clean Solve';
  // 语义：有 AC 就有 Accepted；AC 之外还有 WA/TLE/RE/CE 就不算 Clean Solve
  cs.dataset.earned = cleanSolve ? 'true' : 'false';
  wrap.append(cs);
  return wrap;
}

/**
 * 轨道号码（"03"）。
 *
 * 官方不是写文字，是【数字精灵】+【同位的一块实心白块】两层：
 *   prefab: TrackNumber/UI_Track/NUM_TrackNumber          UI_CMN_Num_26p_N         50x28 抓图
 *           TrackNumber/UI_Track/NUM_TrackNumber_Outline  UI_CMN_Num_26p_Outline_N 50x28 抓图（同位）
 *   反编译: KOP_ResultTrackData 里 `_trackNoImages[0].ChangeSprite(trackNumber)`
 *           —— _trackNoImages 是数组，每个元素显示一位数字
 *
 * ⚠️ 那个 Outline **不是描边图，是一整块实心白**（实测不透明 56.8%，ASCII 是一片白）。
 *    它靠 MultipleImage 的 Subtract 混合（MultiImageBlendType.Subtract / _BlendOp=2）
 *    去"减掉"周围做镂空，**不能当普通图层叠上去** —— 叠上去数字会被整块盖住变全白。
 *    所以这里只画数字，描边用 CSS drop-shadow 近似；等解出 Subtract 的真实参数再换。
 * 数字本身是白色，这里按像素尺寸从 prefab 推：容器 60x34 原生放两位 => 每格 30x34 原生。
 */
export function trackNumber(value) {
  const row = document.createElement('span');
  row.className = 'mm-track-num';
  for (const ch of String(value)) {
    if (!/[0-9]/.test(ch)) continue;
    const cell = document.createElement('span');
    cell.className = 'mm-track-digit';
    cell.append(glyph(`UI_CMN_Num_26p_${ch}.png`, { className: 'mm-glyph mm-track-face' }));
    row.append(cell);
  }
  return row;
}

/**
 * 段位：从 D 到 SSS+。
 *
 * 官方只有 D/C/B/A/S 五张**单字**精灵，多字母的段位是重复拼出来的（SS/SSS、AA/AAA、BB/BBB）。
 * S 另有 Blue/Red/Yellow 三个配色：**三个 S 用主色 + Blue + Red，少于三个用 Yellow**
 * （客户端里就是这么配的）。末尾带 + 时补一张 UI_RSL_Rank_Plus。
 *
 * 注意：名字里带 _White 的那几张**不是白字**，是段位动画的碎裂特效，别拿来当字母用。
 */
export function rankWord(rank) {
  const word = document.createElement('span');
  word.className = 'mm-rank-word';
  const raw = String(rank ?? '').toUpperCase();
  const plus = raw.endsWith('+');
  const letters = raw.replace(/\+$/, '');
  if (!letters || ![...letters].every((c) => RANK_LETTERS.has(c))) {
    // 认不出来的段位（例如 AC）原样显示，至少不会画错
    word.textContent = String(rank ?? '');
    return word;
  }
  const files = letters === 'SSS'
    ? ['UI_RSL_Rank_S.png', 'UI_RSL_Rank_S_Blue.png', 'UI_RSL_Rank_S_Red.png']
    : [...letters].map((letter) => letter === 'S'
        ? 'UI_RSL_Rank_S_Yellow.png'
        : `UI_RSL_Rank_${letter}.png`);
  // ⭐ 多字母段位里，后面的字母比第一个小 —— 这是官方的排法，不是等大重复。
  //    量官方预制整图（UI_GAM_Rank_*）的内容宽度：
  //      A  单字 35  | AA 58 | AAA 82     => AAA 只有 3x35 的 78%
  //      B  单字 30  | BB 52 | BBB 75     => BBB 只有 3x30 的 83%
  //      S  单字 30  | SS 58 | SSS 85     => SSS 是 3x30 的 94%（基本等大）
  //    所以 A/B 族的第 2 个起缩到 0.72，S 族保持等大。
  const smallTail = letters[0] === 'A' || letters[0] === 'B';
  files.forEach((file, i) => {
    const cls = 'mm-rank-letter' + (smallTail && i > 0 ? ' mm-rank-letter-sm' : '');
    word.append(glyph(file, { className: cls }));
  });
  if (plus) word.append(glyph('UI_RSL_Rank_Plus.png', { className: 'mm-rank-plus' }));
  return word;
}

/**
 * 大数字：'98.7654' 或 '100.1445%'。
 *
 * 官方这套排法和普通文字排版不一样，是**两套图集混排**（对着抓图核过）：
 *   · 整数部分用大号图集 1110000（格子 72x98，字形 103 原生）
 *   · 小数点和小数部分用小号图集 0001111（格子 62x82，字形 83 原生）
 *   · '%' 用单独的 UI_RSL_Score_Per_*（58x54）
 * 三者的格子**底边对齐**，所以整行共用一条基线；缩放比 98 : 82 : 54。
 *
 * 配色由达成率决定：< 80 蓝、>= 97 金、其余红。
 */
export function scoreNumber(text, { colour = 'Gold' } = {}) {
  const row = document.createElement('span');
  row.className = 'mm-number';
  const value = String(text);
  const dot = value.indexOf('.');
  const whole = dot === -1 ? value.replace('%', '') : value.slice(0, dot);
  const fraction = dot === -1 ? '' : value.slice(dot + 1).replace('%', '');
  const hasPercent = value.endsWith('%');
  // '%' 只有 Gold/Red/Blue 三个变体，没有 Base，缺的落到 Gold
  const percentColour = ['Gold', 'Red', 'Blue'].includes(colour) ? colour : 'Gold';

  const digit = (ch, cls) => {
    const cell = ch === '.' ? (DOT_CELL[colour] ?? DIGIT_CELL['.']) : DIGIT_CELL[ch];
    if (cell === undefined) return null;
    const atlas = cls === 'mm-number-int' ? '1110000' : '0001111';
    return glyph(`UI_NUM_Score_${atlas}_${colour}_${cell}.png`, { className: 'mm-glyph ' + cls });
  };
  for (const ch of whole) {
    const img = digit(ch, 'mm-number-int');
    if (img) row.append(img);
  }
  if (fraction) {
    // 小数点单独挂一个 mm-number-dot：它在格子里的留白和数字完全不是一回事
    // （左16.9 / 右15.4 / 底12.3 px，数字是 2.3 / 2.3 / 3.8），
    // 排版要单独压、两侧单独收，见 dx-result.css 里那段「达成率大数字」。
    const point = digit('.', 'mm-number-frac mm-number-dot');
    if (point) row.append(point);
    for (const ch of fraction) {
      const img = digit(ch, 'mm-number-frac');
      if (img) row.append(img);
    }
  }
  if (hasPercent) row.append(glyph(`UI_RSL_Score_Per_${percentColour}.png`, { className: 'mm-glyph mm-number-percent' }));
  return row;
}

/** 达成率对应哪套配色：< 80 蓝、>= 97 金、其余红 */
export function achievementColour(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'Gold';
  if (number >= 97) return 'Gold';
  if (number < 80) return 'Blue';
  return 'Red';
}

/* ------------------------------------------------------------------ *
 * 题目卡（原「乐曲卡」，prefab 里是 UI_MusicData）
 * ------------------------------------------------------------------ */

/**
 * 卡片底板：官方 `UI_RSL_MBase_*`，745x142 原生，一张一个难度色。
 *
 * prefab 量出来的构件（原生 px，相对底板左上角）——下面 CSS 里的百分比都按这张表算：
 *   IMG_Background   UI_RSL_MBase_ADV      整张 745x142
 *   JacketImage      槽位 x11..95 / y47..131（板上烤着一块纯黑，游戏里拿曲绘盖住）
 *   Mask             深蓝标题条 x106..709 / y88..128（也烤在板上）
 *   难度名           x≈106..335 / y≈50..80（BASIC/ADVANCED/EXPERT/MASTER/…）
 *   GameType         UI_RSL_MBase_Parts_01 84x28 → 摆在 x≈488..572 / y≈51..75
 *
 * ⚠️ 板上烤着难度名，题目卡不能直接显示它 —— 见 `problemCard()` 里那块 cover：
 *    用同一张板的**干净底色**把那一小段盖掉，位置也是按 prefab 量的。
 *
 * ⚠️ 官方七张板（BSC/ADV/EXP/MST/MST_Re/UTG/DMY）里**没有蓝也没有青**
 *    —— maimai 的难度色本来就没有蓝。所以按色相挑一张最近的板，
 *    再用 saturate()+hue-rotate() 把板面主色拉到 cfRatingColor 那一档的颜色上。
 *    每组参数都是按 CSS 滤镜矩阵解出来的（sRGB 误差 < 25/255）：
 *      green  板面 #45c124 → #4aa85c    cyan   #45c124 → #3fa8c4
 *      blue   #9f51dc → #4a7fe0          violet #9f51dc → #8b6cf0
 *      orange #ffba01 → #f08c3a          red    #ff5a66 → #e8564f
 *      gray   #969696 → #7b8391
 *    深蓝标题条会被这个滤镜带偏，所以脚本另外压一条自己的 navy（`.dx-result-track-bar`）。
 */
const CARD_TONES = {
  green: { plate: 'UI_RSL_MBase_BSC.png', level: 'BSC', field: '#45c124', filter: 'saturate(0.66) hue-rotate(15deg)' },
  cyan: { plate: 'UI_RSL_MBase_BSC.png', level: 'BSC', field: '#45c124', filter: 'saturate(0.68) hue-rotate(79deg)' },
  blue: { plate: 'UI_RSL_MBase_MST.png', level: 'MST', field: '#9f51dc', filter: 'saturate(0.98) hue-rotate(-44deg)' },
  violet: { plate: 'UI_RSL_MBase_MST.png', level: 'MST', field: '#9f51dc', filter: 'saturate(1.08) hue-rotate(-14deg)' },
  orange: { plate: 'UI_RSL_MBase_ADV.png', level: 'EXP', field: '#ffba01', filter: 'saturate(1.2) hue-rotate(-37deg)' },
  red: { plate: 'UI_RSL_MBase_EXP.png', level: 'EXP', field: '#ff5a66', filter: 'saturate(0.9) hue-rotate(12deg)' },
  gray: { plate: 'UI_RSL_MBase_DMY.png', level: 'MST', field: '#969696', filter: 'saturate(0) brightness(0.87)' },
  /* 未评级（题目还没难度）：底板用官方 **UTAGE**（宴）卡 UI_RSL_MBase_UTG.png（745x141）。
     它的轮廓和灰 DMY（板上烤着 DUMMY）**逐点相同**（alpha 包围盒、圆盘拟合完全一致），
     差别只有配色：UTG 板面是粉紫，板上烤着「U・TA・GE」（x110..243/y53..70，
     落在 cover 那块补丁 x96..304/y41..87 里，会被完全盖掉）。
     所以灰档配 DMY 其实等于没换 —— 要的是 UTAGE 那张卡本身。
     filter 取 none：那套 saturate/hue-rotate 是为了把七张难度板的板面主色拉到
     CF 那一档的颜色上（蓝/青/绿…），unrated 没有对应档位，UTAGE 卡是什么色就该是什么色。
     field #ff86fe：这是 cover 那圈**紧邻的板面平色**，和另外五张板同一个取法
     （BSC→#45c124、MST→#9f51dc、DMY→#969696 都是这么取的，逐个核对过）。
     ⚠️ 不能拿 cover **里面**的主色：UTG 那块补丁里压着一片洋红 (249,45,218)，
        而补丁四周是浅粉 (255,134,254)，照搬里面那块会在标题左边留下一个
        深洋红的方块（上下两条边都露）。补丁必须和**外面**接得上。
     ⚠️ level 仍是 MST：图集里没有 UTG 族（只有 BSC/EXP/MST/MST_Re），
        「LV」那个字母只能借一族，MST 的紫最接近这张粉卡。 */
  unrated: { plate: 'UI_RSL_MBase_UTG.png', level: 'MST', field: '#ff86fe', filter: 'none' },
};

/** tone → { plate, level, field, filter }，认不出来的一律按未评级（官方那张灰 DMY） */
export function cardTone(tone) {
  return CARD_TONES[tone] ?? CARD_TONES.unrated;
}

/** 等级数字图集 `UI_CMN_MusicLevel_{族}_{格}.png` 的格子号：0-9 是数字，14 是「LV」 */
const LEVEL_CELL = { '+': 10, '-': 11, ',': 12, '.': 13, LV: 14 };

/** 难度未知时顶在数字位置上的那个字。图集里没有问号（15 格 = 0-9 + - , . LV），只能排字 */
const UNKNOWN_LEVEL = '?';

/** 「?」那颗字。样式在 dx-result.css 的 .mm-level-unknown（按数字精灵的白芯配大小/基线） */
function unknownLevelMark() {
  const node = document.createElement('span');
  node.className = 'mm-level-unknown';
  node.textContent = UNKNOWN_LEVEL;
  node.setAttribute('aria-label', '难度待定');
  return node;
}

/**
 * 官方等级数字。等宽格子 48x60，数字/符号直接按格子号取图。
 * ⚠️ 第 14 格画的是 **LV** 两个字母（不是任务描述里说的 '%'）——
 *    对着官方抓图核过：卡片右端那个小 `LV` 就是这个格子，所以不用 UI_KLD_MSS_Level_*
 *    （那五张是「LEVEL」美字的**噪声动画帧**，单张拿出来是散开的色偏切片）。
 * `value` 里的 '?' 走 unknownLevelMark()（文字，不是精灵），其余认不出的字符跳过。
 *
 * 结构：`.mm-level` 里两个**各自绝对定位**的子节点 ——
 *   `.mm-level-lv`      LV，钉死在卡片里一个固定 x（见 dx-result.css）
 *   `.mm-level-digits`  这一串数字（或那个 `?`），整体以圆盘圆心为心居中
 * 分开包一层是必须的：LV 固定、数字居中，两者不能还在同一条 flex 行里，
 * 否则 LV 的 x 一定会跟着数字宽度跑（改之前就是这样）。见 dx-result.css 那段注释。
 */
export function levelNumber(value, { tone = 'unrated' } = {}) {
  const { level } = cardTone(tone);
  const row = document.createElement('span');
  row.className = 'mm-level';
  const cell = ch => (/^[0-9]$/.test(ch) ? Number(ch) : LEVEL_CELL[ch]);
  const lv = cell('LV');
  row.append(glyph(`UI_CMN_MusicLevel_${level}_${lv}.png`, { className: 'mm-level-lv' }));
  const digits = document.createElement('span');
  digits.className = 'mm-level-digits';
  for (const ch of String(value)) {
    if (ch === UNKNOWN_LEVEL) { digits.append(unknownLevelMark()); continue; }
    const index = cell(ch);
    if (index === undefined) continue;
    digits.append(glyph(`UI_CMN_MusicLevel_${level}_${index}.png`, { className: 'mm-level-digit' }));
  }
  row.append(digits);
  return row;
}

/** GameType 徽章（官方 `UI_RSL_MBase_Parts_01`，就是抓图上那块「でらっくす」小牌） */
export function gameTypeBadge() {
  const wrap = document.createElement('span');
  wrap.className = 'mm-gametype';
  wrap.append(glyph('UI_RSL_MBase_Parts_01.png'));
  return wrap;
}

/**
 * 题目卡内容：官方底板 + 官方等级数字。
 *
 * 结构（外层 `.dx-result-track` 保留在弹窗里，只往里塞这些东西）：
 *   art    底板的画布 —— saturate/hue-rotate 只作用在这一层
 *   plate  底板本体
 *   cover  盖掉板上烤着的难度名（用同一张板的干净底色，所以滤镜一加还是严丝合缝）
 *   bar    深蓝标题条（自己压的 navy，免得被滤镜带偏）
 *   slot   曲绘槽 → 放题号
 *   heading 难度名那一段 → 放赛制/平台
 *   badge  でらっくす
 *   title  标题条 → 放题名
 *   level  右侧圆盘 → LV + 难度分
 *
 * `difficulty` 为 null 时（题目还没难度）不画数字，等级那一格画一个文字「?」，
 * 底板落到 UTAGE 那张卡（`tone` 会是 unrated，见 CARD_TONES.unrated）。
 *
 * `kind` 是**已经翻好的字面**（练习类型：INDEPENDENT/REPLAY/…，调用方从 dx-timer.js 的
 * PRACTICE_KIND_LABEL 取），`platform` 是**平台 key**（codeforces/atcoder/…，不是字面），
 * 由 problem-source.js 的 PLATFORM_LABELS 翻成卡片上的字。给 key 而不是字面，
 * 是为了让「平台词」永远有值：不传/认不出都会落回那边的默认值，卡片不会空一格。
 * 两个词都不在这份模板里写死。
 */
export function problemCard({ problemId = '', kind = '', platform = '', title = '', difficulty = null, tone = 'unrated' } = {}) {
  const info = cardTone(tone);
  const card = document.createDocumentFragment();
  const span = (className, text) => {
    const node = document.createElement('span');
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const art = span('dx-result-track-art');
  art.setAttribute('aria-hidden', 'true');
  art.append(span('dx-result-track-plate'), span('dx-result-track-cover'));
  const bar = span('dx-result-track-bar');
  bar.setAttribute('aria-hidden', 'true');

  const slot = span('dx-result-track-slot');
  slot.textContent = String(problemId).replace(/[:\s]/g, '');
  slot.setAttribute('aria-label', `题目 ${problemId}`);

  // 难度名那一段换成赛制 + 平台：左边的题号已经在曲绘槽里了，这里不重复。
  // 两个词都来自 key→字面的表，不在模板里写死字符串（见上面的参数说明）。
  const heading = span('dx-result-track-heading');
  heading.append(span('dx-result-kind', kind), span('dx-result-problem', platformLabel(platform)));

  const name = document.createElement('h3');
  name.className = 'dx-result-name';
  const titleText = span('dx-result-title', String(title || problemId));
  name.append(titleText);

  const level = span('dx-result-level dx-result-level-disc');
  if (Number.isFinite(difficulty)) level.append(levelNumber(String(difficulty), { tone }));
  /* 没难度：底板是 UTAGE 卡（见 CARD_TONES.unrated），等级那一格画「?」——
     官方图集里没有问号精灵，用文字顶上，字号/基线对着数字精灵的白芯配（见 CSS）。
     原来这里退回文字「待定」（.dx-result-level-pending，样式还留在 dx-result.css 里，
     要换回来改这一行就行）：「LV ?」和「待定」说的是同一件事，并排写重复；
     而且两段加起来会把整组往左推 38px（1200 视口实测盒 x 683 → 645）。 */
  else level.append(levelNumber(UNKNOWN_LEVEL, { tone }));

  card.append(art, bar, slot, heading, gameTypeBadge(), name, level);
  return card;
}

