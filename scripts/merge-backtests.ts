import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { mergeLocalReports } from '../src/dx/backtest.ts';

const args = process.argv.slice(2);
if (args.includes('--help') || !args.length) {
  console.log('npm run backtest:merge -- --out=results/local-backtest-merged.json report1.json report2.json\n每人仅选一份最新报告。只在本地汇总，不上传；不同年度/时区/算法/曲线须分开。');
} else {
  let output = 'results/local-backtest-merged.json';
  const files: string[] = [];
  for (const arg of args) {
    if (arg.startsWith('--out=')) output = arg.slice(6);
    else if (arg.startsWith('--')) throw new Error(`未知参数：${arg}`);
    else files.push(resolve(arg));
  }
  if (new Set(files).size !== files.length) throw new Error('不能重复传入同一文件');
  if (files.includes(resolve(output))) throw new Error('输出路径不能覆盖输入报告');
  const report = mergeLocalReports(files.map(file => JSON.parse(readFileSync(file, 'utf8'))));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`已在本地汇总 ${files.length} 份报告：${output}`);
}
