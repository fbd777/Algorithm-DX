import { cfRatingColor } from './cf-rating-colors.js';

/** Render server-provided B50 scores locally, independent of viewport and scroll position. */
export async function saveB50Image(data, userName, profile = null) {
  await document.fonts.ready;
  const width = 1600, margin = 48, gap = 16, cardWidth = (width - margin * 2 - gap * 4) / 5;
  const cardHeight = 216;
  const groups = [
    { title: '旧题 · BEST 35', label: 'B35', slots: data.board.old, count: data.board.oldCount, capacity: data.slots.old },
    { title: '新题 · BEST 15', label: 'B15', slots: data.board.current, count: data.board.currentCount, capacity: data.slots.current },
  ];
  const height = 340 + groups.reduce((sum, group) => sum + 86 + Math.ceil(group.capacity / 5) * (cardHeight + gap), 0) + 80;
  const canvas = document.createElement('canvas');
  const scale = 1.5;
  canvas.width = width * scale; canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器无法生成图片，请换用支持图片导出的浏览器');
  ctx.scale(scale, scale);
  const theme=profile?.loadout?.b50ThemeId??'b50_theme:newcomer';
  const backdrop=ctx.createLinearGradient(0,0,width,height);
  if(theme==='b50_theme:sss'){backdrop.addColorStop(0,'#21172e');backdrop.addColorStop(.55,'#633b67');backdrop.addColorStop(1,'#b2762e');}
  else if(theme==='b50_theme:result-blue'){backdrop.addColorStop(0,'#071a32');backdrop.addColorStop(.55,'#104d82');backdrop.addColorStop(1,'#267f9f');}
  else {backdrop.addColorStop(0,'#0c121c');backdrop.addColorStop(.6,'#14233a');backdrop.addColorStop(1,'#241b35');}
  ctx.fillStyle=backdrop;ctx.fillRect(0,0,width,height);
  const texturePath=theme==='b50_theme:sss'?'/assets/maimai/result-bg/result-bg-sss.png'
    :theme==='b50_theme:result-blue'?'/assets/maimai/result-bg/result-bg-b.png':'/assets/collectibles/lxns/frame-11.png';
  const texture=new Image();texture.src=texturePath;
  try {
    await texture.decode();const tileHeight=width*texture.naturalHeight/texture.naturalWidth;
    ctx.save();ctx.globalAlpha=.25;
    for(let y=0;y<height;y+=tileHeight)ctx.drawImage(texture,0,y,width,tileHeight);
    ctx.restore();
  } catch { /* The gradient remains a complete offline fallback. */ }
  const font = (size, weight) => `${weight} ${size}px "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Noto Sans SC", sans-serif`;
  const text = (value, x, y, size = 20, color = '#e6edf3', weight = 400, maxWidth, align = 'left') => {
    ctx.font = font(size, weight);
    ctx.textAlign = align;
    ctx.fillStyle = color;
    let label = String(value);
    if (maxWidth && ctx.measureText(label).width > maxWidth) {
      const chars = Array.from(label);
      while (chars.length && ctx.measureText(chars.join('') + '…').width > maxWidth) chars.pop();
      label = chars.join('') + '…';
    }
    ctx.fillText(label, x, y);
  };
  // Keep two lines for titles, including long Chinese names and unbroken IDs.
  const title = (value, x, y, maxWidth) => {
    let remaining = String(value).replace(/\s+/g, ' ').trim();
    ctx.font = font(20, 600);
    const chars = Array.from(remaining);
    let end = 0;
    while (end < chars.length && ctx.measureText(chars.slice(0, end + 1).join('')).width <= maxWidth) end++;
    let first = chars.slice(0, end).join('');
    if (end < chars.length) {
      const space = first.lastIndexOf(' ');
      if (space > first.length / 2) first = first.slice(0, space);
    }
    remaining = remaining.slice(first.length).trimStart();
    text(first, x, y, 20, '#e6edf3', 600, maxWidth);
    if (remaining) text(remaining, x, y + 25, 20, '#e6edf3', 600, maxWidth);
  };
  const box = (x, y, w, h, fill, stroke = '#283247') => {
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 16);
    ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke();
  };
  const clock = seconds => {
    const s = Math.round(seconds), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
    return `${h ? h + ':' + String(m).padStart(2, '0') : m}:${String(s % 60).padStart(2, '0')}`;
  };
  const loadImage=async source=>{
    if(!source)return null;
    const image=new Image();if(/^https:/i.test(source))image.crossOrigin='anonymous';image.src=source;
    try{await image.decode();return image;}catch{return null;}
  };
  const drawImageCover=(image,x,y,w,h,radius=8)=>{
    const scale=Math.max(w/image.naturalWidth,h/image.naturalHeight),dw=image.naturalWidth*scale,dh=image.naturalHeight*scale;
    ctx.save();ctx.beginPath();ctx.roundRect(x,y,w,h,radius);ctx.clip();ctx.drawImage(image,x+(w-dw)/2,y+(h-dh)/2,dw,dh);ctx.restore();
  };
  const owned=profile?.owned??[],equipped=id=>owned.find(item=>item.id===id);
  const titleItem=equipped(profile?.loadout?.titleId),infoFrameItem=equipped(profile?.loadout?.infoFrameId),avatarItem=equipped(profile?.loadout?.avatarId);
  const avatarSource=profile?.loadout?.avatarSource??'collectible';
  const selectedAvatar=avatarSource==='custom'?profile?.loadout?.customAvatar
    :avatarSource==='codeforces'?profile?.cfAvatar:avatarSource==='atcoder'?profile?.atcoderAvatar:avatarItem?.image;
  const [plateImage,selectedAvatarImage,fallbackAvatarImage,danImage]=await Promise.all([
    loadImage(infoFrameItem?.image),loadImage(selectedAvatar),loadImage(avatarItem?.image),loadImage(profile?.highestDan?.image),
  ]);
  const plateX=margin,plateY=34,plateW=720,plateH=116,contentX=plateX+122,contentW=295;
  if(plateImage)ctx.drawImage(plateImage,plateX,plateY,plateW,plateH);
  else {const fallback=ctx.createLinearGradient(plateX,plateY,plateX+plateW,plateY);fallback.addColorStop(0,'#fff');fallback.addColorStop(.62,'#ffb5ec');fallback.addColorStop(1,'#9b78ef');ctx.fillStyle=fallback;ctx.beginPath();ctx.roundRect(plateX,plateY,plateW,plateH,12);ctx.fill();}
  const avatarImage=selectedAvatarImage??fallbackAvatarImage;
  if(avatarImage)drawImageCover(avatarImage,plateX+14,plateY+13,88,88,7);
  else {ctx.fillStyle='#293959';ctx.beginPath();ctx.roundRect(plateX+14,plateY+13,88,88,7);ctx.fill();text(userName.slice(0,1).toUpperCase(),plateX+58,plateY+70,38,'#fff',800,undefined,'center');}
  const tone=cfRatingColor(data.board.rating).tone,ratingColors={gray:['#aeb7bf','#626d76'],green:['#67c779','#237441'],cyan:['#41c7d4','#137384'],blue:['#588cde','#254b9c'],violet:['#9b67d4','#5b3290'],orange:['#e59b45','#984c19'],red:['#df5870','#8e263e']};
  const [ratingMain,ratingDeep]=ratingColors[tone]??ratingColors.gray;
  const ratingGradient=ctx.createLinearGradient(contentX,plateY+17,contentX,plateY+39);ratingGradient.addColorStop(0,'#a8e8aa');ratingGradient.addColorStop(1,ratingMain);
  ctx.fillStyle=ratingGradient;ctx.strokeStyle=ratingDeep;ctx.lineWidth=1;ctx.beginPath();ctx.roundRect(contentX,plateY+17,198,23,5);ctx.fill();ctx.stroke();
  text('DX RATING',contentX+9,plateY+33,9,'#fff',900);
  ctx.fillStyle='#13234e';ctx.beginPath();ctx.roundRect(contentX+121,plateY+19,73,19,3);ctx.fill();text(Number(data.board.rating).toFixed(1),contentX+188,plateY+34,16,'#fff6bd',800,68,'right');
  ctx.fillStyle='#fffffff0';ctx.beginPath();ctx.roundRect(contentX,plateY+45,contentW,26,4);ctx.fill();
  let badgeWidth=0;if(danImage){badgeWidth=52;const badgeHeight=22;ctx.drawImage(danImage,contentX+contentW-badgeWidth-3,plateY+47,badgeWidth,badgeHeight);}
  text(userName,contentX+13,plateY+65,20,'#253050',900,contentW-badgeWidth-22);
  const rarityFill={starter:'#d7f4f5',white:'#f6f8fb',bronze:'#a9673f',silver:'#cfd7df',gold:'#e5bd3e',rainbow:'#b86dcc'}[titleItem?.rarity]??'#f6f8fb';
  const rarityInk=['bronze','rainbow'].includes(titleItem?.rarity)?'#fff':'#26354b';
  ctx.fillStyle=rarityFill;ctx.beginPath();ctx.roundRect(contentX,plateY+75,contentW,22,4);ctx.fill();
  text(titleItem?.name??'新手挑战者',contentX+contentW/2,plateY+91,12,rarityInk,800,contentW-18,'center');
  text('ALGORITHM DX', 820, 54, 20, '#90baff', 700);
  text('BEST 50', 820, 104, 42, '#e6edf3', 800);
  const viewLabel=data.platform==='mixed'?'Codeforces × AtCoder 混合榜':data.platform==='atcoder'?'AtCoder':'Codeforces';
  text(`${data.year} 年度 · ${viewLabel}`, 820, 139, 22, '#a4b1c5', 400, 720);
  const oldTotal = data.board.old.reduce((n, slot) => n + (slot.score?.rating ?? 0), 0);
  const newTotal = data.board.current.reduce((n, slot) => n + (slot.score?.rating ?? 0), 0);
  box(margin, 230, width - margin * 2, 70, '#151f30c9');
  text(`旧题 ${oldTotal.toFixed(1)}  +  新题 ${newTotal.toFixed(1)}`, margin + 24, 274, 24, '#cfe6ff', 600);
  text(`已入榜 ${data.board.oldCount + data.board.currentCount} / 50`, 1240, 274, 22, '#a4b1c5');
  let y = 340;
  for (const group of groups) {
    text(group.title, margin, y + 30, 28, '#e6edf3', 700);
    text(`${group.count} / ${group.capacity}`, width - margin, y + 30, 22, '#a4b1c5', 400, 118, 'right');
    text(group.label === 'B35' ? `${data.year} 年以前发布` : `${data.year} 年发布`, margin, y + 61, 18, '#8998af');
    y += 86;
    for (let i = 0; i < group.capacity; i++) {
      const slot = group.slots[i], x = margin + (i % 5) * (cardWidth + gap), cy = y + Math.floor(i / 5) * (cardHeight + gap);
      const entry = slot?.entry, score = slot?.score;
      if (!entry || !score) {
        box(x, cy, cardWidth, cardHeight, '#101824b8', '#1e293b');
        text(`${group.label} #${String(i + 1).padStart(2, '0')}`, x + 18, cy + 29, 14, '#57677e', 600);
        text('待上榜', x + 18, cy + 119, 24, '#57677e');
        continue;
      }
      const tone = score.rank.startsWith('SS') ? '#ffd166' : score.rank.startsWith('S') ? '#f0883e'
        : score.rank.startsWith('A') ? '#58a6ff' : score.rank.startsWith('B') ? '#3fb950' : '#8998af';
      const platformColor=entry.platform==='atcoder'?'#d65b69':'#3187d8';
      const gradient = ctx.createLinearGradient(x, cy, x + cardWidth, cy + cardHeight);
      gradient.addColorStop(0, entry.platform==='atcoder'?'#2d1d29d9':'#19263ad9'); gradient.addColorStop(1, '#101827c9');
      box(x, cy, cardWidth, cardHeight, gradient,platformColor);
      ctx.fillStyle = platformColor; ctx.fillRect(x, cy + 14, 4, cardHeight - 28);
      const right = x + cardWidth - 18;
      text(`${group.label} #${String(i + 1).padStart(2, '0')}`, x + 18, cy + 29, 14, '#a4b1c5', 600);
      const source=entry.platform==='atcoder'?'ATCODER':'CODEFORCES';
      text(source, x + 108, cy + 29, 11, platformColor, 800, 86);
      text(entry.problemId, right, cy + 29, 14, '#8998af', 400, cardWidth - 205, 'right');
      title(entry.problemTitle || entry.problemId, x + 18, cy + 59, cardWidth - 36);
      text('完成度', x + 18, cy + 107, 13, '#8998af');
      text(score.achievementShown.toFixed(4) + '%', x + 18, cy + 140, 25, '#e6edf3', 800, cardWidth - 130);
      const rankAsset={'S':'gam-rank-s.png','S+':'gam-rank-sp.png','SS':'gam-rank-ss.png','SS+':'gam-rank-ssp.png','SSS':'gam-rank-sss.png','SSS+':'gam-rank-sssp.png'}[score.rank];
      if(rankAsset){
        const img=new Image();img.src=`/assets/maimai/${rankAsset}`;
        try{
          await img.decode();
          // The source badges intentionally have different widths (S through SSS+).
          // Keep their native dimensions and align only their right edge.
          ctx.drawImage(img,right-img.naturalWidth,cy+105,img.naturalWidth,img.naturalHeight);
        }catch{text(score.rank,right,cy+140,25,tone,800,66,'right');}
      }else text(score.rank, right, cy + 140, 25, tone, 800, 66, 'right');
      const difficulty=entry.platform==='atcoder'&&entry.nativeProblemRating!=null
        ? `AT ${entry.nativeProblemRating} → CF ${entry.problemRating ?? '—'}`:`难度 ${entry.problemRating ?? '—'}`;
      text(difficulty, x + 18, cy + 166, 15, '#a4b1c5',400,cardWidth-120);
      text(clock(entry.recordedSeconds), right, cy + 166, 15, '#a4b1c5', 600, 110, 'right');
      ctx.beginPath(); ctx.moveTo(x + 18, cy + 181); ctx.lineTo(right, cy + 181);
      ctx.strokeStyle = '#283247'; ctx.lineWidth = 1; ctx.stroke();
      text('单题 Rating', x + 18, cy + 202, 14, '#8998af');
      text(Number(score.rating).toFixed(1), right, cy + 202, 16, '#a4b1c5', 600, 100, 'right');
    }
    y += Math.ceil(group.capacity / 5) * (cardHeight + gap);
  }
  const themeName=profile?.owned?.find(item=>item.id===theme)?.name??'Prism 新手舞台';
  text(`${viewLabel} · ${themeName} · 空位按 0 分计入 · DX Rating 为娱乐向换算`, margin, height - 37, 18, '#aebdd2');
  text(new Date().toLocaleDateString('zh-CN'), width - 190, height - 37, 18, '#8998af');
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('图片生成失败，请重试');
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  const safeName = String(userName).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 60) || 'player';
  link.download = `Algorithm-DX-B50-${safeName}-${data.year}.png`;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
