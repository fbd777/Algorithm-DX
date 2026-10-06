/**
 * 把统计实验的主推 T97 曲线导出成应用能直接读的 TypeScript 模块。
 *
 * 为什么要有这一步：客户端算单题 rating 需要「某个题目 Rating 的 T97 是多少」，
 * 而那条曲线是 `scripts/cf-study/` 算出来的。如果客户端自己抄一份数字，
 * 以后曲线一改就会出现「研究说 A、面板显示 B」——和研究线里
 * `problem-scope.ts`、`core.mjs` 的口径唯一出处是同一条规矩。
 *
 * 所以：CSV 是源，本脚本是唯一的转换点，`src/dx/curve.ts` 是产物。
 * 产物里嵌源文件 SHA256 与诊断状态，便于反查「面板上这条曲线是哪次实验的」。
 *
 * 主推模型取 success（成功者中位耗时）。理由见 docs/cf-maimai-study.md：
 * KM 那条是「总体 50% 解出」诊断量，不是 97% 锚点。
 *
 *   用法：node scripts/cf-study/export-dx-curve.mjs
 */
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { FIT_MIN_Q, FIT_MAX_Q } from './core.mjs';

const root = 'results/cf-study';
const outFile = 'src/dx/curve.ts';
const MODEL = 'success';

const csv = await fs.readFile(`${root}/t97_monotone.csv`, 'utf8');
const sourceSha256 = createHash('sha256').update(csv).digest('hex');

const lines = csv.trim().split(/\r?\n/);
const header = lines.shift().split(',');
const rows = lines.map((line) => Object.fromEntries(header.map((key, i) => [key, line.split(',')[i]])));

const points = rows
  .filter((r) => r.model === MODEL)
  .map((r) => [Number(r.q), Number(r.monotoneSeconds)])
  .sort((a, b) => a[0] - b[0]);

// 下面几条都是「错了会让面板静默出错」的性质，宁可导出时直接炸，也不要生成一份坏曲线。
if (!points.length) throw new Error(`t97_monotone.csv 里没有 model=${MODEL} 的行`);
if (points[0][0] !== FIT_MIN_Q || points.at(-1)[0] !== FIT_MAX_Q) {
  throw new Error(`曲线端点 ${points[0][0]}–${points.at(-1)[0]} 与拟合范围 ${FIT_MIN_Q}–${FIT_MAX_Q} 不一致`);
}
for (let i = 1; i < points.length; i++) {
  const step = points[i][0] - points[i - 1][0];
  if (step !== 25) throw new Error(`网格步长应为 25，第 ${i} 点为 ${step}`);
  if (points[i][1] < points[i - 1][1] - 1e-9) {
    throw new Error(`曲线在 ${points[i][0]} 处不单调（${points[i - 1][1]} → ${points[i][1]}）`);
  }
  if (!(points[i][1] > 0)) throw new Error(`曲线在 ${points[i][0]} 处不是正数`);
}

/** 诊断状态取自 validate.mjs 写的 diagnostics.json；缺了就按「未验证」处理，不假装已就绪。 */
let diagnostics = { productionReady: false, basis: 'diagnostics.json 缺失' };
try {
  const raw = JSON.parse(await fs.readFile(`${root}/diagnostics.json`, 'utf8'));
  diagnostics = {
    productionReady: Boolean(raw.productionReady),
    basis: typeof raw.productionReadyBasis === 'string' ? raw.productionReadyBasis : '（未记录判据说明）',
  };
} catch {
  // 保留上面的「未验证」默认值。曲线本身仍然是有效的探索性估计。
}

const body = `/**
 * 本文件由 \`node scripts/cf-study/export-dx-curve.mjs\` 生成，**请勿手改**。
 *
 * 源：${root}/t97_monotone.csv（model=${MODEL} 的 monotoneSeconds 列）
 * 源文件 SHA256：${sourceSha256}
 * 导出时间：${new Date().toISOString()}
 *
 * 曲线含义：题目 Rating → 完成度 97% 所需的比赛内用时（秒）。
 * 主推模型为「成功者中位耗时」，在核平滑之上做过加权保序回归，因此**不随难度下降**。
 * 完备性与限制见 results/cf-study/VALIDATION.md、T97_TABLE.md。
 */
import type { DxCurve } from './types.ts';

export const DX_CURVE: DxCurve = {
  model: '${MODEL}',
  sourceFile: '${root}/t97_monotone.csv',
  sourceSha256: '${sourceSha256}',
  generatedAt: '${new Date().toISOString()}',
  fitMinQ: ${FIT_MIN_Q},
  fitMaxQ: ${FIT_MAX_Q},
  gridStepQ: 25,
  productionReady: ${diagnostics.productionReady},
  productionReadyBasis: ${JSON.stringify(diagnostics.basis)},
  // [题目 Rating, T97 秒]
  points: [
${points.map(([q, s]) => `    [${q}, ${Math.round(s * 1000) / 1000}],`).join('\n')}
  ],
};
`;

await fs.mkdir('src/dx', { recursive: true });
await fs.writeFile(outFile, body);

console.log(`导出 ${outFile}`);
console.log(`  ${points.length} 个网格点，${points[0][0]}–${points.at(-1)[0]}，步长 25`);
console.log(`  T97 范围 ${(points[0][1] / 60).toFixed(2)}–${(points.at(-1)[1] / 60).toFixed(2)} 分钟`);
console.log(`  源 SHA256 ${sourceSha256.slice(0, 16)}…`);
console.log(`  productionReady=${diagnostics.productionReady}`);
