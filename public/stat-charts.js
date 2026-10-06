const colors = ['#5bceac','#62a8ff','#ad93ff','#f2c66d','#f38a96','#68d5e7','#c1cbdd'];
const node = (tag,text,cls) => { const n=document.createElement(tag); if(text)n.textContent=text; if(cls)n.className=cls;return n; };
const font = 'system-ui, "Microsoft YaHei", sans-serif';
function text(ctx, value, x, y, size=12, color='#a9b8cd',align='left') { ctx.font=`${size}px ${font}`;ctx.fillStyle=color;ctx.textAlign=align;ctx.fillText(String(value),x,y); }
function shorten(value,n=24) { return value.length>n ? value.slice(0,n-1)+'…' : value; }

export function chart(title, input, note='', type='bar') {
  const box=node('section',null,'analytics-chart');box.append(node('h3',title),node('p',note,'analytics-note'));
  // Keep all rows available in the accessible detail list and in exports.
  const rows=input, total=rows.reduce((n,r)=>n+r.count,0), max=Math.max(1,...rows.map(r=>r.count));
  const height=type==='bar' ? Math.max(160,rows.length*29+30) : type==='donut' ? Math.max(250,rows.length*27+40) : 260;
  const canvas=node('canvas',null,'stat-canvas');canvas.width=1040;canvas.height=height*2;canvas.setAttribute('role','img');
  canvas.setAttribute('aria-label',`${title}。${rows.map(r=>`${r.label}：${r.count}`).join('；')}`);
  const ctx=canvas.getContext('2d');ctx.scale(2,2);ctx.fillStyle='#141e2e';ctx.fillRect(0,0,520,height);
  if (!total) {text(ctx,'此范围暂无数据',260,height/2,15,'#8798b2','center');}
  else if (type==='donut') {
    let angle=-Math.PI/2;
    rows.forEach((r,i)=> {const end=angle+r.count/total*Math.PI*2;ctx.beginPath();ctx.arc(115,125,76,angle,end);ctx.strokeStyle=colors[i%colors.length];ctx.lineWidth=24;ctx.stroke();angle=end;
      ctx.fillStyle=colors[i%colors.length];ctx.fillRect(225,22+i*27,9,9);text(ctx,shorten(r.label,23),243,31+i*27);text(ctx,`${r.count} · ${(r.count/total*100).toFixed(1)}%`,505,31+i*27,11,'#e0eafb','right');});
    text(ctx,total,115,127,30,'#e6edf3','center');text(ctx,'次提交',115,151,12,'#8798b2','center');
  } else if(type==='line' || type==='columns') {
    const left=42,right=500,top=28,bottom=210,axisMax=Math.ceil(max/4)*4;
    for(let i=0;i<=4;i++){const y=bottom-(bottom-top)*i/4;ctx.strokeStyle='#27364b';ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(right,y);ctx.stroke();text(ctx,axisMax*i/4,left-8,y+4,10,'#8798b2','right');}
    const x=i=>left+(right-left)*(rows.length===1?0.5:i/(rows.length-1));
    const y=r=>bottom-r.count/axisMax*(bottom-top);
    if(type==='line') {
      ctx.beginPath();rows.forEach((r,i)=>i?ctx.lineTo(x(i),y(r)):ctx.moveTo(x(i),y(r)));ctx.strokeStyle=colors[0];ctx.lineWidth=2.5;ctx.stroke();
      ctx.lineTo(x(rows.length-1),bottom);ctx.lineTo(x(0),bottom);ctx.closePath();const g=ctx.createLinearGradient(0,top,0,bottom);g.addColorStop(0,'#5bceac55');g.addColorStop(1,'#5bceac00');ctx.fillStyle=g;ctx.fill();
      rows.forEach((r,i)=>{if(rows.length<=40){ctx.beginPath();ctx.arc(x(i),y(r),3,0,Math.PI*2);ctx.fillStyle=colors[0];ctx.fill();}});
    } else rows.forEach((r,i)=>{const w=(right-left)/rows.length;ctx.fillStyle=colors[1];ctx.fillRect(left+i*w+2,y(r),Math.max(1,w-4),bottom-y(r));});
    rows.forEach((r,i)=>{if(i===0||i===rows.length-1||i%Math.max(1,Math.ceil(rows.length/6))===0) text(ctx,r.label.length>7?r.label.slice(5):r.label,type==='line'?x(i):left+(i+.5)*(right-left)/rows.length,233,10,'#8798b2','center');});
    text(ctx,'提交次数',left,14,10);
  } else {
    rows.forEach((r,i)=>{const y=20+i*29; text(ctx,shorten(r.label,25),5,y+12,12);ctx.fillStyle='#233147';ctx.fillRect(195,y,250,12);ctx.fillStyle=r.color||colors[i%colors.length];ctx.fillRect(195,y,250*r.count/max,12);if(r.color){ctx.strokeStyle='#ffffff55';ctx.lineWidth=1;ctx.strokeRect(195,y,250*r.count/max,12);}text(ctx,r.count,508,y+12,12,'#e0eafb','right');});
  }
  const viewport=node('div',null,'stat-canvas-frame');viewport.append(canvas);box.append(viewport);
  const detail=node('details',null,'chart-values');detail.append(node('summary','查看完整数据'));
  const list=node('dl');for(const r of rows){list.append(node('dt',r.label),node('dd',`${r.count}${type==='donut'&&total?`（${(r.count/total*100).toFixed(1)}%）`:''}`));}detail.append(list);box.append(detail);
  if(type==='line'||type==='columns') canvas.addEventListener('mousemove',event=>{
    const x=(event.clientX-canvas.getBoundingClientRect().left)/canvas.getBoundingClientRect().width*520;
    const index=Math.max(0,Math.min(rows.length-1,Math.round((x-42)/458*(rows.length-1))));
    canvas.title=rows[index]?`${rows[index].label}：${rows[index].count} 次提交`:'';
  });
  return box;
}

function wrap(ctx, value, x, y, width, size=14) {
  ctx.font=`${size}px ${font}`;let line='';
  for(const char of value) {if(ctx.measureText(line+char).width>width){text(ctx,line,x,y,size);line='';y+=size+8;}line+=char;}
  text(ctx,line,x,y,size);return y+size+8;
}

/** Compose a local PNG from the same canvases shown on screen, without a CDN or upload. */
export async function saveStatisticsImage() {
  await document.fonts.ready;
  const graphs=[...document.querySelectorAll('#analytics .analytics-chart')];
  const width=1200,pad=40;
  const heights=graphs.map(box=> Math.ceil(box.querySelector('canvas').height/box.querySelector('canvas').width*(width-pad*2))+130);
  const todayCards=[...document.querySelectorAll('.today-card')];
  const todayHeight=document.getElementById('todayHost')?240+todayCards.length*175:0;
  const height=680+todayHeight+heights.reduce((a,b)=>a+b,0);
  // Keep browser canvas allocation below ~24 million pixels for large histories.
  const scale=Math.min(2,Math.sqrt(24000000/(width*height)),16000/height);
  const canvas=document.createElement('canvas');canvas.width=Math.floor(width*scale);canvas.height=Math.floor(height*scale);
  const ctx=canvas.getContext('2d');if(!ctx)throw new Error('浏览器无法创建图片');ctx.scale(scale,scale);
  ctx.fillStyle='#0b1220';ctx.fillRect(0,0,width,height);
  text(ctx,'Algorithm DX / 练习数据',pad,58,30,'#e6edf3');
  const user=document.getElementById('statsUser').selectedOptions[0].textContent;
  const platform=document.getElementById('statsPlatform').selectedOptions[0].textContent;
  text(ctx,`${user} · 下方统计平台：${platform}`,pad,91,15);
  const range=document.querySelector('#analytics [role="status"]').textContent;
  wrap(ctx,range,pad,122,width-pad*2,14);
  text(ctx,'每日 AC 热力图 · 全部平台',pad,180,20,'#e6edf3');
  text(ctx,document.querySelector('#heatmapHost h4')?.textContent||'',pad,210,14);
  const mode=document.querySelector('[aria-label="热力图统计口径"]');text(ctx,mode.selectedOptions[0].textContent,width-pad,210,14,'#a9b8cd','right');
  const cells=[...document.querySelectorAll('#heatmapHost .heat-grid > *')];
  const palette=['#242f3c','#164f38','#24764b','#32a665','#61d78d'];
  cells.forEach((cell,i)=>{if(!cell.classList.contains('heat-cell'))return;const date=cell.getAttribute('aria-label')?.slice(0,10);if(date?.endsWith('-01'))text(ctx,Number(date.slice(5,7))+'月',pad+Math.floor(i/7)*20,229,10);const level=Number([...cell.classList].find(c=>c.startsWith('level-'))?.slice(6)||0);ctx.fillStyle=palette[level];ctx.fillRect(pad+Math.floor(i/7)*20,235+i%7*20,16,16);});
  text(ctx,'少',pad,408,12);palette.forEach((color,i)=>{ctx.fillStyle=color;ctx.fillRect(pad+25+i*22,396,16,16);});text(ctx,'多',pad+143,408,12);
  const metrics=[...document.querySelectorAll('.analytics-metrics > div')];
  metrics.forEach((tile,i)=>{const x=pad+(i%3)*370,y=458+Math.floor(i/3)*75;text(ctx,tile.querySelector('span').textContent,x,y,13);text(ctx,tile.querySelector('strong').textContent,x,y+32,27,'#e6edf3');});
  let y=620;
  if(todayHeight){
    text(ctx,'今日练习 / DAILY SESSION',pad,y+20,24,'#83e7bb');
    wrap(ctx,document.querySelector('.today-heading p')?.textContent||'',pad,y+48,width-pad*2,13);
    [...document.querySelectorAll('.today-metrics>div')].forEach((tile,i)=>{
      const x=pad+i*280;text(ctx,tile.querySelector('span').textContent,x,y+95,13);
      text(ctx,tile.querySelector('strong').textContent,x,y+128,23,'#e4f6ee');
    });
    y+=175;
    if(!todayCards.length)text(ctx,'今天还没有已同步的 AC 记录',pad,y+15,15);
    for(const card of todayCards){
      ctx.fillStyle='#141e2e';ctx.fillRect(pad-12,y-8,width-pad*2+24,160);
      text(ctx,card.querySelector('.today-stamp').textContent,pad+8,y+19,15,'#83e7bb');
      wrap(ctx,card.querySelector('h4').textContent,pad+155,y+19,800,18);
      text(ctx,[...card.querySelectorAll('.today-card-meta span')].map(n=>n.textContent).join(' · '),pad+8,y+63,13);
      const perf=[...card.querySelectorAll('.today-performance>div')].map(n=>n.textContent).join('   /   ');
      text(ctx,perf||card.querySelector('.analytics-note').textContent,pad+8,y+94,14,'#dce8f4');
      text(ctx,card.querySelector('.today-rank').textContent,width-pad-8,y+94,19,'#f5d78b','right');
      const notes=[...card.querySelectorAll('.analytics-note')];text(ctx,notes.at(-1)?.textContent||'',pad+8,y+125,12);
      y+=175;
    }
    text(ctx,'用时仅关联当日 AC 记录；DX Rank 是本项目练习评级，不是 CF 官方排名。',pad,y+25,12);y+=65;
  }
  graphs.forEach((box,i)=>{ctx.fillStyle='#141e2e';ctx.fillRect(pad-12,y-12,width-pad*2+24,heights[i]-16);text(ctx,box.querySelector('h3').textContent,pad+8,y+20,21,'#e6edf3');const graph=box.querySelector('canvas');wrap(ctx,box.querySelector('p')?.textContent||'',pad+8,y+48,width-pad*2-16,13);const h=graph.height/graph.width*(width-pad*2);ctx.drawImage(graph,pad,y+88,width-pad*2,h);y+=heights[i];});
  text(ctx,'以本地已同步记录为准 · Algorithm DX · '+new Date().toLocaleString('zh-CN'),pad,height-25,12);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!blob)throw new Error('图片生成失败，请缩小统计范围后重试');
  const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`Algorithm-DX-${new Date().toISOString().slice(0,10)}.png`;document.body.append(link);link.click();link.remove();
  const preview=node('dialog',null,'image-export-preview');
  const heading=node('h3','统计图片已生成');
  const hint=node('p','若浏览器未自动下载，可点击「下载 PNG」或右键保存下方图片。','analytics-note');
  const download=node('a','下载 PNG','btn btn-primary');download.href=url;download.download=link.download;
  const close=node('button','关闭预览','btn btn-ghost');close.type='button';close.addEventListener('click',()=>preview.close());
  const image=node('img');image.src=url;image.alt='当前范围的完整练习统计图片';
  const actions=node('div',null,'form-actions');actions.append(download,close);preview.append(heading,hint,actions,image);document.body.append(preview);
  preview.addEventListener('close',()=>{preview.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);},{once:true});preview.showModal();

}
