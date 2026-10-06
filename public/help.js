import { startAutoSync } from './auto-sync.js';
startAutoSync();
const text = (tag, value) => { const node = document.createElement(tag); node.textContent = value; return node; };
try {
  const response = await fetch('/api/dx/rules');
  if (!response.ok) throw new Error('规则暂时无法读取');
  const { scoring, curve, rankTimes } = await response.json();
  document.getElementById('currentScoring').textContent = '当前参数：单题 rating 分母为 ' + scoring.divisor + '；用时等于 T97 时系数为 ' + scoring.atT97.toFixed(3) + '；SSS+（100.5%）系数为 ' + scoring.atSSSPlus.toFixed(3) + '。';
  const table = document.createElement('table'); table.className = 'rt-table';
  const head = document.createElement('tr'); for (const label of ['等级', '完成度', '用时 ÷ T97', '系数']) head.append(text('th', label)); table.append(head);
  for (const row of rankTimes.ladder) { const tr = document.createElement('tr'); for (const value of [row.rank, row.achievement + '%', row.ratio.toFixed(3), row.factor.toFixed(3)]) tr.append(text('td', value)); table.append(tr); }
  document.getElementById('scoringLadder').append(table);
  const details = document.getElementById('curveDetails'); details.replaceChildren();
  for (const value of ['模型：' + curve.model, '启用难度范围：' + curve.fitMinQ + '–' + curve.fitMaxQ, '拟合输入范围：' + (curve.calibrationMinQ ?? curve.fitMinQ) + '–' + (curve.calibrationMaxQ ?? curve.fitMaxQ), '验证状态：' + (curve.productionReady ? '通过当前判据' : '尚未通过全部判据'), '验证依据：' + curve.productionReadyBasis, '来源：' + curve.sourceFile, '生成时间：' + curve.generatedAt, '源文件指纹：' + curve.sourceSha256]) details.append(text('p', value));
} catch {
  document.getElementById('currentScoring').textContent = '当前参数读取失败，请启动或重启 Dashboard 后刷新。上方可先查看规则说明。';
  document.getElementById('curveDetails').textContent = '模型状态暂时无法读取。';
}
