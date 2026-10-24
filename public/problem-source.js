/**
 * 结算卡片那行小字里的**平台词**：平台 key → 卡片上印的字面。
 *
 * 卡片右上那行小字是两个词：练习类型（INDEPENDENT / REPLAY / …，由 dx-timer.js 的
 * PRACTICE_KIND_LABEL 给）+ 判题平台（这一份）。平台词原来是写死在
 * maimai-glyphs.js 的 problemCard() 里的字符串 'CODEFORCES'，以后题目会来自别的判题站，
 * 所以收到这张表里，全站只有这一处决定卡片印什么。
 *
 * key 用的是 `src/fetchers/registry.ts` 里那套平台标识（accounts.platform 用的也是它），
 * 别另造一套拼法。字面走**全大写拉丁**：底板那一格官方烤的是难度名（BASIC/EXPERT…），
 * 都是大写拉丁，这里跟着它。注意这和 stat-labels.js 的 platformNames 不是一件事 ——
 * 那是账号/统计页的中文名（Codeforces、洛谷、码蹄集），卡片要的是板上的短词，
 * 分开放，谁的措辞要改都不会带偏对方。
 *
 * 今天服务端只会发 Codeforces（见 dx-timer.js 里的说明），所以实际渲染仍然是 CODEFORCES；
 * 以后接别的判题站时，只要那边把 platform 一起发下来、
 * 调用方把 key 传给 problemCard({ platform })，这张表直接就能用。
 */
export const PLATFORM_LABELS = {
  codeforces: 'CODEFORCES',
  atcoder: 'ATCODER',
  leetcode: 'LEETCODE',
  'leetcode-cn': 'LEETCODE CN',
  luogu: 'LUOGU',
  nowcoder: 'NOWCODER',
  matiji: 'MATIJI',
};

/** 没有平台信息时（今天就是这种）卡片印哪一个。 */
export const DEFAULT_PLATFORM = 'codeforces';

/**
 * 平台 key → 卡片上的字面。空值、认不出的 key 一律落回 DEFAULT_PLATFORM：
 * 卡片这一格不能空着。
 */
export function platformLabel(platform) {
  const key = String(platform ?? '').trim().toLowerCase();
  return PLATFORM_LABELS[key] ?? PLATFORM_LABELS[DEFAULT_PLATFORM];
}
