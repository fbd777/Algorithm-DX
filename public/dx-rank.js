/**
 * 达成率 → 段位。
 *
 * 官方规则：一局游玩取得的评级**只与达成率有关**（见 maimai 的评级表，A 是 80.0000%~89.9999%、
 * SSS+ 是 100.5000% 起）。服务端 `src/dx/rating.ts` 的 `rankOf` 就是查这张表。
 *
 * 这里放一份同表的前端副本，为的是让结算单上显示的**数字和段位永远对得上**：
 * 数字可以被覆盖（调试用 `?achievement=`），段位跟着它走，
 * 不会出现「88.8888% 配 S」这种自相矛盾的画面。
 *
 * 两边必须一致：`tests/dx-rank.test.ts` 会把它和服务端那张表逐项比，
 * 只改一边会让测试变红。
 */

/** 段位门槛，顺序从高到低；和服务端 RANK_LADDER 同源 */
export const RANK_LADDER = [
  ['SSS+', 100.5], ['SSS', 100], ['SS+', 99.5], ['SS', 99], ['S+', 98], ['S', 97],
  ['AAA', 94], ['AA', 90], ['A', 80], ['BBB', 75], ['BB', 70], ['B', 60], ['C', 50],
];

/** 查表取段位；低于最低门槛（50%）是 D */
export function rankOf(achievement) {
  const value = Number(achievement);
  if (!Number.isFinite(value)) return 'D';
  for (const [name, floor] of RANK_LADDER) if (value >= floor) return name;
  return 'D';
}
