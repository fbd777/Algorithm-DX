import { startAutoSync } from './auto-sync.js';
startAutoSync();
const text = (tag, value) => { const node = document.createElement(tag); node.textContent = value; return node; };
try {
  const response = await fetch('/api/dx/rules');
  if (!response.ok) throw new Error('规则暂时无法读取');
  const { scoring, curve, rankTimes } = await response.json();
  document.getElementById('currentScoring').textContent = '当前计分除数为 ' + scoring.divisor + '。用时等于参考用时 T97 时，计分系数为 ' + scoring.atT97.toFixed(3) + '；达到 SSS+（100.5%）时，系数为 ' + scoring.atSSSPlus.toFixed(3) + '。';
  const table = document.createElement('table'); table.className = 'rt-table';
  const head = document.createElement('tr'); for (const label of ['评级', '达成率', '用时 / 参考用时', '计分系数']) head.append(text('th', label)); table.append(head);
  for (const row of rankTimes.ladder) { const tr = document.createElement('tr'); for (const value of [row.rank, row.achievement + '%', row.ratio.toFixed(3), row.factor.toFixed(3)]) tr.append(text('td', value)); table.append(tr); }
  document.getElementById('scoringLadder').append(table);
  const details = document.getElementById('curveDetails'); details.replaceChildren();
  for (const value of [
    '当前用于评分的题目难度范围：' + curve.fitMinQ + '–' + curve.fitMaxQ + '。',
    '拟合时实际参考的难度范围：' + (curve.calibrationMinQ ?? curve.fitMinQ) + '–' + (curve.calibrationMaxQ ?? curve.fitMaxQ) + '；启用范围中超出这一段的数值属于外推。',
    '统计验证：' + (curve.productionReady ? '已通过项目当前设定的检查标准，仍不代表适合每个人。' : '尚未通过全部检查标准；模型仍在使用，这个状态不影响记录练习或计算成绩。'),
    '具体依据：' + curve.productionReadyBasis,
  ]) details.append(text('p', value));
  const technical = document.createElement('details');
  technical.append(text('summary', '开发与复核信息'));
  for (const value of ['模型标识：' + curve.model, '来源文件：' + curve.sourceFile, '生成时间：' + curve.generatedAt, '源文件指纹：' + curve.sourceSha256]) technical.append(text('p', value));
  details.append(technical);
} catch {
  document.getElementById('currentScoring').textContent = '暂时读不到当前计分参数。请确认本机 Algorithm DX 启动窗口仍在运行，然后刷新页面；上面的操作步骤仍可阅读。';
  document.getElementById('curveDetails').textContent = '模型状态暂时无法读取。';
}
