/** Render server-provided B50 scores locally, independent of viewport and scroll position. */
export async function saveB50Image(data, userName) {
  await document.fonts.ready;
  const width = 1600, margin = 48, gap = 16, cardWidth = (width - margin * 2 - gap * 4) / 5;
  const cardHeight = 216;
  const groups = [
    { title: '旧题 · BEST 35', label: 'B35', slots: data.board.old, count: data.board.oldCount, capacity: data.slots.old },
    { title: '新题 · BEST 15', label: 'B15', slots: data.board.current, count: data.board.currentCount, capacity: data.slots.current },
  ];
  const height = 308 + groups.reduce((sum, group) => sum + 86 + Math.ceil(group.capacity / 5) * (cardHeight + gap), 0) + 80;
  const canvas = document.createElement('canvas');
  const scale = 1.5;
  canvas.width = width * scale; canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器无法生成图片，请换用支持图片导出的浏览器');
  ctx.scale(scale, scale);
  ctx.fillStyle = '#0c121c'; ctx.fillRect(0, 0, width, height);
  const text = (value, x, y, size = 20, color = '#e6edf3', weight = 400, maxWidth) => {
    ctx.font = `${weight} ${size}px "Segoe UI", "Microsoft YaHei", sans-serif`;
    ctx.fillStyle = color;
    let label = String(value);
    if (maxWidth && ctx.measureText(label).width > maxWidth) {
      const chars = Array.from(label);
      while (chars.length && ctx.measureText(chars.join('') + '…').width > maxWidth) chars.pop();
      label = chars.join('') + '…';
    }
    ctx.fillText(label, x, y);
  };
  const box = (x, y, w, h, fill, stroke = '#283247') => {
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 16);
    ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke();
  };
  const clock = seconds => {
    const s = Math.round(seconds), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
    return `${h ? h + ':' + String(m).padStart(2, '0') : m}:${String(s % 60).padStart(2, '0')}`;
  };
  text('ALGORITHM DX', margin, 65, 22, '#90baff', 700);
  text('BEST 50', margin, 127, 46, '#e6edf3', 800);
  text(`${userName} · ${data.year} 年度`, margin, 169, 24, '#a4b1c5', 400, 980);
  text('DX RATING', 1160, 76, 20, '#a4b1c5', 600);
  text(Number(data.board.rating).toFixed(1), 1160, 142, 58, '#ffd166', 800);
  const oldTotal = data.board.old.reduce((n, slot) => n + (slot.score?.rating ?? 0), 0);
  const newTotal = data.board.current.reduce((n, slot) => n + (slot.score?.rating ?? 0), 0);
  box(margin, 205, width - margin * 2, 70, '#151f30');
  text(`旧题 ${oldTotal.toFixed(1)}  +  新题 ${newTotal.toFixed(1)}`, margin + 24, 249, 24, '#cfe6ff', 600);
  text(`已入榜 ${data.board.oldCount + data.board.currentCount} / 50`, 1240, 249, 22, '#a4b1c5');
  let y = 308;
  for (const group of groups) {
    text(group.title, margin, y + 30, 28, '#e6edf3', 700);
    text(`${group.count} / ${group.capacity}`, width - margin - 118, y + 30, 22, '#a4b1c5');
    text(group.label === 'B35' ? `${data.year} 年以前发布` : `${data.year} 年发布`, margin, y + 61, 18, '#8998af');
    y += 86;
    for (let i = 0; i < group.capacity; i++) {
      const slot = group.slots[i], x = margin + (i % 5) * (cardWidth + gap), cy = y + Math.floor(i / 5) * (cardHeight + gap);
      const entry = slot?.entry, score = slot?.score;
      if (!entry || !score) {
        box(x, cy, cardWidth, cardHeight, '#101824', '#1e293b');
        text(`${group.label} #${i + 1}`, x + 18, cy + 35, 17, '#57677e');
        text('待上榜', x + 18, cy + 119, 24, '#57677e');
        continue;
      }
      const tone = score.rank.startsWith('SS') ? '#ffd166' : score.rank.startsWith('S') ? '#f0883e'
        : score.rank.startsWith('A') ? '#58a6ff' : score.rank.startsWith('B') ? '#3fb950' : '#8998af';
      const gradient = ctx.createLinearGradient(x, cy, x + cardWidth, cy + cardHeight);
      gradient.addColorStop(0, '#1b2336'); gradient.addColorStop(1, '#101827');
      box(x, cy, cardWidth, cardHeight, gradient);
      ctx.fillStyle = tone; ctx.fillRect(x, cy + 16, 3, cardHeight - 32);
      text(score.rank, x + 18, cy + 38, 28, tone, 800);
      text(`${group.label} #${i + 1}`, x + cardWidth - 88, cy + 35, 16, '#a4b1c5');
      text(entry.problemId, x + 18, cy + 68, 16, '#8998af', 400, cardWidth - 36);
      text(entry.problemTitle || entry.problemId, x + 18, cy + 98, 20, '#e6edf3', 600, cardWidth - 36);
      text('完成度', x + 18, cy + 130, 14, '#8998af');
      text('单题 Rating', x + 163, cy + 130, 14, '#8998af');
      text(score.achievementShown.toFixed(4) + '%', x + 18, cy + 155, 22, '#e6edf3', 700);
      text(Number(score.rating).toFixed(1), x + 163, cy + 155, 22, '#e6edf3', 700);
      text(`难度 ${entry.problemRating ?? '—'}`, x + 18, cy + 193, 17, '#a4b1c5');
      text(clock(entry.recordedSeconds), x + 163, cy + 193, 19, '#a4b1c5', 600);
    }
    y += Math.ceil(group.capacity / 5) * (cardHeight + gap);
  }
  text('Codeforces 练习成绩 · 空位按 0 分计入 · DX Rating 为娱乐向换算', margin, height - 37, 18, '#8998af');
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
