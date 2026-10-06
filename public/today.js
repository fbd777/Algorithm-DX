import { difficultyLabel, difficultyClass, languageLabel, platformNames } from './stat-labels.js';
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
const duration=s=>s==null?'未记录':`${Math.floor(s/60)} 分 ${s%60} 秒`;
const time=s=>new Date(s*1000).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false});
export function renderToday(data) {
  const host=document.getElementById('todayHost');host.replaceChildren();host.removeAttribute('aria-busy');
  const {summary:s,cards}=data;
  const head=el('div',null,'today-heading');
  const title=el('div');title.append(el('span','TODAY / DAILY SESSION','stats-eyebrow'),el('h2','今天，又前进了一点'),el('p',`${data.date} · 今日数据随用户和平台筛选，不随下方历史日期切换`,'analytics-note'));
  head.append(title,el('span',`${s.solved} AC`,'today-total'));host.append(head);
  const metrics=el('div',null,'today-metrics');
  for(const [label,value,note]of[
    ['今日 AC 题目',s.solved,`${s.fresh} 道首次通过 · ${s.solved-s.fresh} 道再次通过`],
    ['提交通过率',s.submissions?`${Math.round(s.ac/s.submissions*100)}%`:'—',`${s.ac} 次 AC / ${s.submissions} 次提交`],
    ['已记录用时',s.timed?duration(s.seconds):'未记录',`${s.timed} / ${s.solved} 道有当天计时`],
    ['最佳 DX Rank',s.bestRank??'待点亮',s.bestTitle??'记录 CF 练习用时后生成'],
  ]){const tile=el('div');tile.append(el('span',label),el('strong',value),el('small',note));metrics.append(tile);}
  host.append(metrics);
  const rhythm=el('div',null,'today-rhythm');
  rhythm.append(el('div','24 小时提交节奏','today-section-title'));
  const bars=el('div',null,'today-hours');const max=Math.max(1,...data.hours.map(h=>h.submissions));
  for(const h of data.hours){const bar=el('div',null,'today-hour');bar.title=`${h.hour}:00 · ${h.submissions} 次提交 / ${h.ac} 次 AC`;const track=el('i');track.style.height=`${Math.max(3,h.submissions/max*48)}px`;const fill=el('b');fill.style.height=`${h.submissions?h.ac/h.submissions*100:0}%`;track.append(fill);bar.append(track,el('span',h.hour%3===0?String(h.hour).padStart(2,'0'):''));bars.append(bar);}
  rhythm.append(bars,el('p','绿色：AC · 灰蓝：其他提交','analytics-note'));host.append(rhythm);
  const heading=el('div',null,'today-list-heading');heading.append(el('h3','今日 AC 时间线'),el('span',`${s.unfinished} 道今日尝试尚未 AC`,'analytics-note'));host.append(heading);
  const list=el('div',null,'today-cards');
  for(const card of cards){
    const item=el('article',null,'today-card');
    const stamp=el('div',null,'today-stamp');stamp.append(el('strong',time(card.lastAc)),el('span',card.fresh?'首次 AC':'再次 AC'));item.append(stamp);
    const content=el('div',null,'today-card-content');const meta=el('div',null,'today-card-meta');meta.append(el('span',platformNames[card.platform]||card.platform),el('span',card.problemId),el('span',difficultyLabel(card.platform,card.difficulty),difficultyClass(card.platform,card.difficulty)),el('span',card.userName));
    const link=el('a',card.title);if(card.url&&/^https?:\/\//i.test(card.url)){link.href=card.url;link.target='_blank';link.rel='noopener noreferrer';}
    const name=el('h4');name.append(link);content.append(meta,name,el('p',`${card.submissions} 次今日提交 · ${card.ac} 次 AC · ${languageLabel(card.language)}`,'analytics-note'));
    {
      const performance=el('div',null,'today-performance');
      for(const [label,value]of[['练习用时',duration(card.seconds)],['DX 完成度',card.score?`${card.score.achievementShown.toFixed(4)}%`:'—'],['DX 单题分',card.score?card.score.rating.toFixed(1):'—']]){const cell=el('div');cell.append(el('span',label),el('strong',value));performance.append(cell);}
      content.append(performance);
      const kind={first:'首次练习',repeat:'重复练习',assisted:'借助提示',unknown:'类型未标注'}[card.practiceKind];
      const source=card.timingSource==='contest_estimate'?'比赛估算计时':'手动计时';
      const note=card.seconds===null?'尚未记录本次 AC 的用时':`${kind||'历史计时'} · ${source} · ${time(card.practiceAt)} 的 AC${card.practiceKind==='assisted'?' · 辅助练习不评级':card.difficulty===null?' · 题目难度缺失，暂不评级':''}${card.score?.extrapolated?' · 超出模型拟合范围，使用外推':''}`;
      content.append(el('p',note,'analytics-note'));
      if(card.seconds===null){const record=el('a','记录练习用时 ↗','today-record');record.href='/dx.html?'+new URLSearchParams({view:'history',add:'1',user:String(card.userId),platform:card.platform,problem:card.problemId});content.append(record);}
    }
    const badge=el('div',card.score?.rank??'AC',`today-rank${card.score?' is-rated':''}`);badge.append(el('small',card.score?'DX RANK':'ACCEPTED'));item.append(content,badge);list.append(item);
  }
  if(!cards.length)list.append(el('div',s.submissions?'今天已有尝试，第一道 AC 正在路上。':'今天的时间线还空着，完成练习并同步后会出现在这里。','today-empty'));
  host.append(list,el('p','按「用户 + 平台 + 题号」汇总，时间为今日最后一次 AC；首次以已同步历史判断。用时只关联当天 AC 对应的有效练习记录，每题取最新一次。DX 完成度和 Rank 沿用本项目模型，不是 CF 官方排名；已记录用时不代表全天学习时长。','analytics-note'));
  const model=el('p',`评分模型：${data.curve.model} · ${data.curve.productionReady?'已通过验证':'实验曲线，评级仅供参考'} · ${data.curve.sourceSha256.slice(0,12)}`,'analytics-note');
  const rules=el('a','查看 DX 评分说明');rules.href='/dx.html';model.append(' · ',rules);host.append(model);
}
