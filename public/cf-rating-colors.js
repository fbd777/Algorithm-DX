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
