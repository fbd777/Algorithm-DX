import { chart } from './stat-charts.js';
import { difficultyLabel, difficultyColor, difficultyNote, platformNames, mergeLanguages } from './stat-labels.js';
const make = (tag, text, cls) => {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (cls) node.className = cls;
  return node;
};
const iso = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const dateValue = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00`);
  return Number.isFinite(+d) && iso(d) === value ? d : null;
};
export function periodBounds(period, anchor, end = anchor) {
  if (period === 'all') return {};
  const start = dateValue(anchor), finish = dateValue(end);
  if (!start || !finish) throw new Error('请填写有效日期');
  if (period === 'week') { start.setDate(start.getDate() - (start.getDay() + 6) % 7); finish.setTime(+start); finish.setDate(finish.getDate() + 6); }
  if (period === 'month') { start.setDate(1); finish.setTime(+start); finish.setMonth(finish.getMonth() + 1); finish.setDate(0); }
  if (period === 'year') { start.setMonth(0, 1); finish.setTime(+start); finish.setFullYear(finish.getFullYear() + 1); finish.setDate(0); }
  if (period === 'day') finish.setTime(+start);
  if (finish < start) throw new Error('结束日期不能早于开始日期');
  finish.setDate(finish.getDate() + 1);
  return { since: Math.floor(+start / 1000), until: Math.floor(+finish / 1000) - 1 };
}

export function shiftPeriodDate(period, anchor, direction) {
  const date = dateValue(anchor);
  if (!date) throw new Error('请填写有效日期');
  if (period === 'day' || period === 'week') date.setDate(date.getDate() + direction * (period === 'week' ? 7 : 1));
  else if (period === 'month') { date.setDate(1); date.setMonth(date.getMonth() + direction); }
  else if (period === 'year') { date.setMonth(0, 1); date.setFullYear(date.getFullYear() + direction); }
  else throw new Error('此统计范围不支持快捷切换');
  return iso(date);
}

export function initAnalytics(onChange) {
  const panel = make('section', null, 'analytics');
  panel.id = 'analytics';
  const head = make('div', null, 'analytics-head');
  head.append(make('div', '练习数据 · Analytics', 'analytics-title'));
  const form = make('form', null, 'analytics-controls');
  const period = make('select', null, 'select'); period.setAttribute('aria-label', '统计时间范围');
  for (const [v, label] of [['day', '按日'], ['week', '按周'], ['month', '按月'], ['year', '按年'], ['custom', '自定义区间'], ['all', '全部历史']]) {
    const o = make('option', label); o.value = v; period.append(o);
  }
  const anchor = make('input', null, 'input'); anchor.type = 'date'; anchor.setAttribute('aria-label', '统计日期或开始日期');
  const end = make('input', null, 'input'); end.type = 'date'; end.setAttribute('aria-label', '结束日期');
  for (const input of [anchor, end]) { input.min = '1970-01-02'; input.max = '2099-12-31'; }
  const apply = make('button', '应用', 'btn btn-primary'); apply.type = 'submit';
  const url = new URLSearchParams(location.search);
  period.value = ['day','week','month','year','custom','all'].includes(url.get('period')) ? url.get('period') : 'all';
  anchor.value = dateValue(url.get('date') || '') ? url.get('date') : iso(new Date());
  end.value = dateValue(url.get('end') || '') ? url.get('end') : anchor.value;
  let committed = { period: period.value, date: anchor.value, end: end.value };
  let bounds;
  try { bounds = periodBounds(committed.period, committed.date, committed.end); } catch { period.value = 'all'; committed.period = 'all'; bounds = {}; }
  const field = (label, control) => { const box=make('label',null,'stat-control'); const caption=make('span',label); box.append(caption,control); return {box,caption}; };
  const periodField=field('统计范围',period), anchorField=field('选择日期',anchor), endField=field('结束日期',end);
  let chosenDate=anchor.value;
  const navigation=make('div',null,'stat-navigation');
  navigation.setAttribute('role','group');navigation.setAttribute('aria-label','快捷切换统计日期');
  const previous=make('button','','btn'),current=make('button','','btn'),next=make('button','','btn');
  for(const button of [previous,current,next])button.type='button';
  navigation.append(previous,current,next);
  const anchorDate=()=>anchor.type==='month'?anchor.value+'-01':anchor.type==='number'?anchor.value+'-01-01':anchor.value;
  const visibility = () => {
    anchorField.box.hidden=period.value==='all';endField.box.hidden=period.value!=='custom';
    anchorField.caption.textContent=({day:'选择日期',week:'选择周内任意一天',month:'选择月份',year:'选择年份',custom:'开始日期'})[period.value]||'选择日期';
    anchor.type=period.value==='month'?'month':period.value==='year'?'number':'date';
    anchor.min=period.value==='year'?'1970':period.value==='month'?'1970-01':'1970-01-02';
    anchor.max=period.value==='year'?'2099':period.value==='month'?'2099-12':'2099-12-31';
    anchor.value=period.value==='year'?chosenDate.slice(0,4):period.value==='month'?chosenDate.slice(0,7):chosenDate;
    anchor.setAttribute('aria-label',anchorField.caption.textContent);
    const labels=({day:['上一天','今天','下一天'],week:['上一周','本周','下一周'],month:['上个月','本月','下个月'],year:['上一年','今年','下一年']})[period.value];
    navigation.hidden=!labels;
    if(labels)[previous,current,next].forEach((button,index)=>button.textContent=labels[index]);
  };
  visibility();
  form.append(periodField.box, anchorField.box, endField.box, navigation, apply); head.append(form); panel.append(head);
  const message = make('p', '', 'analytics-note'); message.setAttribute('role', 'status'); panel.append(message);
  const body = make('div'); panel.append(body);
  document.getElementById('analyticsHost').append(panel);
  const applySelection = () => {
    if(!form.reportValidity())return;
    try {
      bounds = periodBounds(period.value, anchorDate(), period.value==='custom'?end.value:anchorDate());
      committed = { period: period.value, date: anchorDate(), end: end.value };
      message.textContent = ''; onChange();
    } catch (error) { message.textContent = error.message; }
  };
  form.addEventListener('submit',event=>{event.preventDefault();applySelection();});
  period.addEventListener('change',()=>{
    chosenDate=iso(new Date());end.value=chosenDate;visibility();applySelection();
  });
  const navigate = direction => {
    try {
      const date=direction===0?iso(new Date()):shiftPeriodDate(period.value,anchorDate(),direction);
      if(date<'1970-01-02'||date>'2099-12-31'){message.textContent='可选择的日期范围为 1970-01-02 至 2099-12-31';return;}
      chosenDate=date;visibility();applySelection();
    } catch(error){message.textContent=error.message;}
  };
  previous.addEventListener('click',()=>navigate(-1));
  current.addEventListener('click',()=>navigate(0));
  next.addEventListener('click',()=>navigate(1));
  return {
    params: () => bounds,
    syncUrl(search) { search.set('period', committed.period); if (committed.period !== 'all') search.set('date', committed.date); if (committed.period === 'custom') search.set('end', committed.end); },
    loading() { body.style.opacity = '.45'; panel.setAttribute('aria-busy', 'true'); },
    error() { body.replaceChildren(make('p', '统计读取失败，请重新应用筛选。', 'analytics-note')); body.style.opacity = ''; panel.removeAttribute('aria-busy'); },
    render(data) {
      body.replaceChildren(); body.style.opacity = ''; panel.removeAttribute('aria-busy');
      const s = data.summary;
      message.textContent = `${data.start} — ${data.end} · UTC${-new Date().getTimezoneOffset() >= 0 ? '+' : ''}${-new Date().getTimezoneOffset() / 60} · 按所选日期、平台和用户统计。`;
      const metrics = make('div', null, 'analytics-metrics');
      for (const [label, value] of [['AC 提交', s.ac], ['首次 AC 题数', s.fresh], ['提交通过率', `${s.acRate.toFixed(1)}%`], ['最长连续 AC', `${s.longest} 天`], ['截至期末连续 AC', `${s.current} 天`], ['单日最多 AC 题数', s.bestDay]]) {
        const tile = make('div'); tile.append(make('span', label), make('strong', value)); metrics.append(tile);
      }
      body.append(metrics);
      const charts = make('div',null,'analytics-chart-grid');
      const monthly = Date.parse(data.end) - Date.parse(data.start) > 86400000 * 90;
      const trend = new Map();
      for (let d = new Date(`${data.start}T00:00:00Z`); d <= new Date(`${data.end}T00:00:00Z`); d.setUTCDate(d.getUTCDate()+1)) {
        const key = d.toISOString().slice(0,monthly ? 7 : 10); if (!trend.has(key)) trend.set(key,0);
      }
      for (const d of data.days) { const key = d.date.slice(0,monthly ? 7 : 10); trend.set(key,(trend.get(key)||0)+d.submissions); }
      charts.append(chart(monthly ? '提交趋势 · 按月' : '提交趋势 · 按日', [...trend].map(([label,count])=>({label,count})), '全部判题结果 · 横轴为日期，纵轴为提交次数 · 缺失日期补零', 'line'));
      charts.append(chart('判题结果',data.verdicts,'每次提交的判题结果及占比','donut'),chart('编程语言',mergeLanguages(data.languages),'按提交次数统计，保留语言版本差异','donut'),chart('AC 题目标签',data.tags,'每题每标签计一次；多标签题会出现在多个分类。'),chart('24 小时提交分布',data.hours,'按当前时区统计 · 横轴为小时，纵轴为提交次数','columns'));
      for (const d of data.difficulties) charts.append(chart(`${platformNames[d.platform]||d.platform} · AC 题目难度`,d.items.map(r=>({...r,label:difficultyLabel(d.platform,r.label),color:difficultyColor(d.platform,r.label)})),difficultyNote(d.platform)));
      body.append(charts);
      const source = make('a','统计维度参考 Codeforces Analytics'); source.href = 'https://greasyfork.org/en/scripts/465176/code'; source.target = '_blank'; source.rel = 'noopener';
      body.append(source);
    },
  };
}

export function heatmapDates(selected, today = new Date()) {
  const end = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  const start = new Date(end);
  if (/^\d{4}$/.test(selected)) { start.setUTCFullYear(Number(selected), 0, 1); end.setUTCFullYear(Number(selected), 11, 31); }
  else { start.setUTCDate(start.getUTCDate() - 364); }
  return { start: start.toISOString().slice(0,10), end: end.toISOString().slice(0,10) };
}

export function initHeatmap(target, onChange) {
  let selected = new URLSearchParams(location.search).get('heatYear') || 'recent';
  let metric = 'solved', source = null;
  const render = () => {
    if (!source) return;
    const currentYear = new Date().getFullYear();
    const firstYear = Math.min(currentYear, Number(source.start.slice(0,4)));
    const years = Array.from({length: currentYear - firstYear + 1}, (_, i) => currentYear - i);
    if (selected !== 'recent' && !years.includes(Number(selected))) selected = 'recent';
    const bounds = heatmapDates(selected);
    const data = {...bounds, days: source.days.filter(d => d.date >= bounds.start && d.date <= bounds.end)};
      const heat = make('section', null, 'analytics-chart');
      const heatHead = make('div', null, 'analytics-head'); heatHead.append(make('h3', '每日 AC 热力图'));
      const yearSelect = make('select', null, 'select'); yearSelect.setAttribute('aria-label', '热力图年份');
      for (const [value, label] of [['recent', '最近一年'], ...years.map(y => [String(y), `${y} 年`])]) { const o = make('option', label); o.value = value; yearSelect.append(o); }
      yearSelect.value = selected; yearSelect.addEventListener('change', () => { selected = yearSelect.value; render(); onChange(selected); }); heatHead.append(yearSelect);
      const mode = make('select', null, 'select'); mode.setAttribute('aria-label', '热力图统计口径');
      for (const [value, label] of [['solved','当天 AC 题数'], ['ac','AC 提交次数'], ['fresh','首次 AC 题数']]) { const o = make('option', label); o.value = value; mode.append(o); }
      mode.value = metric; heatHead.append(mode); heat.append(heatHead);
      const map = new Map(data.days.map(d => [d.date, d]));
      const plot = make('div');
      const detail = make('p', '悬停、聚焦或点击日期查看数量。', 'analytics-note'); detail.setAttribute('aria-live','polite');
      const legend = make('div', null, 'heat-legend'); legend.append(make('span','少'));
      for(let n = 0; n < 5; n++) legend.append(make('i', null, `heat-cell level-${n}`));
      legend.append(make('span','多 · 颜色按当前范围最大值分级'));
      const draw = () => {
        plot.replaceChildren();
        const max = Math.max(1, ...data.days.map(d => d[metric]));
        const start = new Date(`${data.start}T00:00:00Z`), finish = new Date(`${data.end}T00:00:00Z`);
        {
          plot.append(make('h4', `${data.start} — ${data.end}`));
          const scroll = make('div', null, 'heat-scroll'); const grid = make('div', null, 'heat-grid');
          const calendar = make('div'); const months = make('div', null, 'heat-months');
          const a = new Date(start), b = new Date(finish);
          const padding = (a.getUTCDay() + 6) % 7;
          let index = padding;
          for (let i = 0; i < padding; i++) grid.append(make('span',null,'heat-spacer'));
          for (let d = a; d <= b; d.setUTCDate(d.getUTCDate() + 1)) {
            if (d.getUTCDate() === 1 || index === padding) {
              const label = make('span', `${d.getUTCMonth() + 1}月`);
              label.style.left = `${Math.floor(index / 7) * 18}px`; months.append(label);
            }
            const date = d.toISOString().slice(0,10), row = map.get(date), value = row?.[metric] || 0;
            const level = value ? Math.min(4, Math.ceil(value / max * 4)) : 0;
            const cell = make('button', null, `heat-cell level-${level}`); cell.type = 'button';
            const label = `${date} · AC ${row?.solved || 0} 题 · 首次 AC ${row?.fresh || 0} 题 · AC 提交 ${row?.ac || 0} 次 · 总提交 ${row?.submissions || 0} 次`;
            cell.title = label; cell.setAttribute('aria-label', label);
            for (const event of ['mouseenter','focus','click']) cell.addEventListener(event, () => { detail.textContent = label; });
            grid.append(cell); index++;
          }
          const labels = make('div',null,'heat-weekdays'); for (const label of ['一','二','三','四','五','六','日']) labels.append(make('span',label));
          calendar.append(months,grid); scroll.append(labels,calendar); plot.append(scroll);
        }
      };
      mode.addEventListener('change', () => { metric = mode.value; draw(); }); draw();
      heat.append(plot,legend,detail,make('p','题数按「平台 + 题号」去重，排除洛谷比赛临时编号；同题不同天通过会在各天计数。首次 AC 以所选用户范围内已同步的全部历史为准。热力图汇总所选用户的全部平台，不受下方统计时间和平台筛选影响。','analytics-note'));
      target.replaceChildren(heat);

  };
  return {
    render(data) { source = data; render(); },
    selection: () => selected,
    error() { target.replaceChildren(make('p','热力图读取失败，请刷新重试。','analytics-note')); },
  };
}
