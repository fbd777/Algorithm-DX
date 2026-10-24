const mounted = new WeakMap();

/** Shared by ordinary practice and challenge settlement sheets. */
export function resultBackground(sheet, rank, { still = false } = {}) {
  const palette = { 'SSS+': 'SSS', SSS: 'SSS', 'SS+': 'SS', SS: 'SS',
    'S+': 'S', S: 'S', AAA: 'A', AA: 'A', A: 'A' }[rank] ?? 'B';
  sheet.dataset.bg = palette.toLowerCase();
  let frame = mounted.get(sheet);
  if (!frame) {
    frame = document.createElement('iframe');
    frame.className = 'dx-result-bg';
    frame.setAttribute('scrolling', 'no');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    sheet.prepend(frame);
    mounted.set(sheet, frame);
    const bleed = 24;
    sheet.style.setProperty('--result-bg-bleed', `${bleed}px`);
    const fit = () => sheet.style.setProperty('--result-bg-scale',
      Math.max((sheet.clientWidth + bleed * 2) / 903, (sheet.clientHeight + bleed * 2) / 906, .2).toFixed(4));
    new ResizeObserver(fit).observe(sheet);
    fit();
    sheet.closest('dialog')?.addEventListener('close', () => frame.removeAttribute('src'));
  }
  if (still || matchMedia('(prefers-reduced-motion: reduce)').matches) frame.removeAttribute('src');
  else frame.src = `/mm-result-bg.html?ui=0&clear=1&t=0&rank=${palette}`;
}
