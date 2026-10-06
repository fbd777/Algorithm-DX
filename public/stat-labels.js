// Verified against https://www.luogu.com.cn/_lfe/config on 2026-09-24.
const luoguLanguages = {0:'未知语言',1:'Pascal',2:'C',3:'C++98',4:'C++11',5:'提交答案',6:'Python 2',7:'Python 3',8:'Java 8',9:'Node.js LTS',10:'Shell',11:'C++14',12:'C++17',13:'Ruby',14:'Go',15:'Rust',16:'PHP',17:'C# Mono',18:'Visual Basic Mono',19:'Haskell',20:'Kotlin/Native',21:'Kotlin/JVM',22:'Scala',23:'Perl',24:'PyPy 2',25:'PyPy 3',26:'文言',27:'C++20',28:'C++14 (GCC 9)',29:'F#.NET',30:'OCaml',31:'Julia',32:'Lua',33:'Java 21',34:'C++23'};
const luoguDifficulty = ['暂无评定','入门','普及−','普及','普及+/提高−','提高','提高+/省选−','省选/NOI−','NOI/NOI+/CTS'];
const luoguDifficultyColors = ['#a0a7b4','#fe4c61','#f39c11','#ffc116','#52c41a','#3498db','#9d3dcf','#0e1d69','#0e1d69'];
function luoguLevel(platform, value) {
  if (platform !== 'luogu' || value === null || value === undefined || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n < luoguDifficulty.length ? n : null;
}
export function difficultyClass(platform, value) {
  const level = luoguLevel(platform, value);
  return level === null ? '' : `luogu-difficulty luogu-difficulty-${level}`;
}
export function difficultyColor(platform, value) {
  const level = luoguLevel(platform, value);
  return level === null ? undefined : luoguDifficultyColors[level];
}
export const platformNames = {codeforces:'Codeforces',luogu:'洛谷',atcoder:'AtCoder',leetcode:'LeetCode','leetcode-cn':'力扣中国站',nowcoder:'牛客',matiji:'码蹄集'};
export function languageLabel(value) {
  if (!value) return '未知语言';
  const match = String(value).match(/^luogu\s*language\s*#\s*(\d+)$/i);
  return match ? luoguLanguages[match[1]] || `未知语言（洛谷编号 ${match[1]}）` : value;
}
export function difficultyLabel(platform, value) {
  if (value === null || value === undefined || value === '未知难度') return '未提供难度';
  if (platform === 'luogu') return luoguDifficulty[Number(value)] ?? `未识别等级（${value}）`;
  if (platform === 'codeforces') return `Rating ${value}`;
  return `难度值 ${value}`;
}
export function difficultyNote(platform) {
  if (platform === 'luogu') return '洛谷题目等级 · 按由易到难排列 · 数值表示去重 AC 题数';
  if (platform === 'codeforces') return '题目 Rating，越高通常越难；不是个人 Rating 或 DX 定数 · 单位：题';
  return '按本地保存的题目难度值统计；未提供难度单列，不转换为其他平台等级 · 单位：题';
}
export function mergeLanguages(rows) {
  const result = new Map();
  for (const row of rows) { const label=languageLabel(row.label); result.set(label,(result.get(label)||0)+row.count); }
  return [...result].map(([label,count])=>({label,count})).sort((a,b)=>b.count-a.count);
}
