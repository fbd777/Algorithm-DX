import { cfRatingColor } from './cf-rating-colors.js';

// Canvas counterpart of the original seven CF-tier frames in dx-result.css.
// The thresholds come from the same helper as the on-page player card.
const frames = {
  gray: { edge:'#8d969e', light:'#f0f2f3', dark:'#626d76', number:'#edf0f3', radius:8, angle:145,
    stops:[[0,'#e1e5e8'],[1,'#aeb7bf']] },
  green: { edge:'#317f48', light:'#e1ffd4', dark:'#15532e', number:'#d2f3c8', radius:8, angle:145,
    stops:[[0,'#edffe1'],[.28,'#b8e79f'],[.49,'#58ae70'],[.51,'#d7f8b7'],[.68,'#8dcb8e'],[1,'#459865']] },
  cyan: { edge:'#25aabe', light:'#e2ffff', dark:'#075666', number:'#bdffff', radius:[4,14,4,14], angle:125,
    stops:[[0,'#eaffff'],[.25,'#58d6de'],[.30,'#dafdff'],[.34,'#26aabb'],[.65,'#91e6e6'],[.69,'#edffff'],[.74,'#41bbd1'],[1,'#41bbd1']] },
  blue: { edge:'#729be9', light:'#e9f9ff', dark:'#163776', number:'#d3eaff', radius:[5,17,5,17], angle:130,
    stops:[[0,'#dcefff'],[.24,'#6399e9'],[.30,'#a6cfff'],[.33,'#f8ffff'],[.37,'#3168bb'],[.62,'#7ca9ee'],[.69,'#e8f5ff'],[.73,'#4875c5'],[1,'#244e9d']] },
  violet: { edge:'#dd9eff', light:'#fff0ff', dark:'#491368', number:'#f7dcff', radius:[10,3,10,3], angle:118,
    stops:[[0,'#e9bcff'],[.18,'#a354ce'],[.29,'#f5c5ff'],[.33,'#fffaff'],[.36,'#ffffff'],[.37,'#f3b5ff'],[.41,'#6e269e'],[.58,'#bb66dc'],[.65,'#efbdff'],[.69,'#ffffff'],[.73,'#9f43bf'],[.88,'#e9a5eb'],[1,'#7d329c']] },
  orange: { edge:'#dfa745', light:'#fffce2', dark:'#76400b', number:'#ffe9ad', radius:[3,13,3,13], angle:112,
    stops:[[0,'#f8d372'],[.14,'#b77519'],[.24,'#ffe098'],[.29,'#fffef0'],[.32,'#fff2b3'],[.37,'#b9771c'],[.54,'#edbf5b'],[.61,'#fffce0'],[.67,'#c88d26'],[.86,'#ffe9aa'],[1,'#d39421']] },
  red: { edge:'#ffd790', light:'#fff4cf', dark:'#fff0c4', number:'#fff0b5', radius:[12,4,12,4], angle:120,
    stops:[[0,'#6d0e38'],[.18,'#d32c52'],[.28,'#ff719a'],[.32,'#ffe2d1'],[.35,'#f37d94'],[.40,'#a60c39'],[.62,'#670e3d'],[.75,'#ed4068'],[.80,'#ffd2ba'],[.85,'#a91843'],[1,'#740c30']] },
};

function gradient(ctx, angle, stops, x, y, width, height) {
  const rad = angle * Math.PI / 180, dx = Math.sin(rad), dy = -Math.cos(rad);
  const half = (Math.abs(width * dx) + Math.abs(height * dy)) / 2;
  const cx = x + width / 2, cy = y + height / 2;
  const fill = ctx.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half);
  for (const [position, color] of stops) fill.addColorStop(position, color);
  return fill;
}

/** Fixed-size export drawing; independent of page theme and browser viewport. */
export function drawDxRatingFrame(ctx, rating, x, y, width = 392, height = 88) {
  const tone = cfRatingColor(rating).tone, frame = frames[tone] ?? frames.gray;
  const decorated = ['blue','violet','orange','red'].includes(tone);
  ctx.save();
  ctx.translate(x, y); ctx.scale(width / 392, height / 88);
  const outline = (inset, color, weight = 1) => {
    ctx.beginPath(); ctx.roundRect(inset, inset, 392 - inset * 2, 88 - inset * 2, frame.radius);
    ctx.strokeStyle = color; ctx.lineWidth = weight; ctx.stroke();
  };
  ctx.beginPath(); ctx.roundRect(0, 0, 392, 88, frame.radius);
  ctx.fillStyle = gradient(ctx, frame.angle, frame.stops, 0, 0, 392, 88);
  ctx.shadowColor = tone === 'gray' ? '#0005' : frame.edge + '80'; ctx.shadowBlur = tone === 'gray' ? 5 : 12;
  ctx.fill(); ctx.shadowBlur = 0;
  outline(0, frame.edge, tone === 'gray' ? 1 : 3);
  outline(2, frame.light, tone === 'gray' ? 1 : 2);
  if (decorated) {
    outline(5, frame.edge); outline(7, frame.light);
    ctx.fillStyle = frame.light;
    for (const [px, py, direction] of [[9,9,1],[383,79,-1]]) {
      ctx.beginPath(); ctx.moveTo(px,py); ctx.lineTo(px + direction * 10,py); ctx.lineTo(px,py + direction * 10); ctx.closePath(); ctx.fill();
    }
  }
  // The original DX logo and the recessed number window stay inside the frame.
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.font = 'italic 900 36px "Arial Black", Arial, sans-serif';
  ctx.fillStyle = gradient(ctx, 170, [[0,'#ffffff'],[.46,frame.light],[.49,frame.edge],[.78,frame.light],[1,frame.light]], 17, 25, 62, 40);
  ctx.strokeStyle = frame.dark; ctx.lineWidth = .8; ctx.strokeText('DX',18,54); ctx.fillText('DX',18,54);
  ctx.font = 'italic 900 13px Arial, sans-serif'; ctx.fillStyle = frame.dark; ctx.fillText('RATING',79,54);
  ctx.fillStyle = gradient(ctx,90,[[0,frame.dark],[1,frame.light]],20,60,112,3);
  ctx.beginPath(); ctx.moveTo(22,60); ctx.lineTo(134,60); ctx.lineTo(125,63); ctx.lineTo(20,63); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.roundRect(147,16,228,56,5);
  ctx.fillStyle = gradient(ctx,180,[[0,'#152031'],[1,'#0b1321']],147,16,228,56); ctx.fill();
  ctx.strokeStyle = decorated ? frame.light : frame.edge; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const label = Number(rating).toFixed(1);
  let size = 38; ctx.font = `700 ${size}px Consolas, "Courier New", monospace`;
  while (size > 16 && ctx.measureText(label).width > 202) ctx.font = `700 ${--size}px Consolas, "Courier New", monospace`;
  ctx.fillStyle = frame.number; ctx.fillText(label,261,45);
  if (['violet','orange','red'].includes(tone)) {
    ctx.font = '22px "Segoe UI Symbol", sans-serif'; ctx.fillStyle = frame.light;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.shadowColor = frame.edge; ctx.shadowBlur = 6;
    ctx.fillText(tone === 'red' ? '◆  ✦  ◆' : tone === 'violet' ? '✧' : '✦', tone === 'red' ? 196 : tone === 'violet' ? 3 : 389, -5);
  }
  ctx.restore();
}
