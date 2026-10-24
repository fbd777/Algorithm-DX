// Apply CF handle-color boundaries to problem difficulty for the result banner.
const bands = [
  [2400, 'red', '红色', '2400+'],
  [2100, 'orange', '橙色', '2100–2399'],
  [1900, 'violet', '紫色', '1900–2099'],
  [1600, 'blue', '蓝色', '1600–1899'],
  [1400, 'cyan', '青色', '1400–1599'],
  [1200, 'green', '绿色', '1200–1399'],
  [0, 'gray', '灰色', '低于 1200'],
];
export function cfRatingColor(rating) {
  if (!Number.isFinite(rating) || rating < 0) return { tone: 'unrated', label: '未评级', range: '待定' };
  const [, tone, label, range] = bands.find(([minimum])=>rating>=minimum);
  return { tone, label, range };
}

/**
 * 每一档 tone 对应的【主色 + 深色】，段位结算页逐题卡片（.dan-track-frame 的
 * --tc1 / --tc2）用的就是这一对。题目卡也走同一张表，避免两处各写一套色。
 * 顺序和上面 bands 一致：红 > 橙 > 紫 > 蓝 > 青 > 绿 > 灰；未评级与灰色同色。
 */
export const CF_TONE_COLORS = {
  red: ['#e8564f', '#a3211c'], orange: ['#f08c3a', '#a85a12'],
  violet: ['#8b6cf0', '#4a2fb0'], blue: ['#4a7fe0', '#1e3f96'],
  cyan: ['#3fa8c4', '#166b83'], green: ['#4aa85c', '#1d6b30'],
  gray: ['#7b8391', '#3f4652'], unrated: ['#7b8391', '#3f4652'],
};

/** tone → [主色, 深色]，认不出来的一律按未评级 */
export function cfToneColors(tone) {
  return CF_TONE_COLORS[tone] ?? CF_TONE_COLORS.unrated;
}
