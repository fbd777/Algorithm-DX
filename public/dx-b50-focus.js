let cancelCurrent = null, highlightedCard = null, highlightTimer = null;

/** Move from a settled score to its refreshed B50 card without fighting user input. */
export async function focusB50Card(card, isCurrent = () => true) {
  cancelCurrent?.();
  clearTimeout(highlightTimer);
  highlightedCard?.classList.remove('dx-b50-arrival');
  highlightedCard = null;
  if (!card.isConnected || !isCurrent()) return false;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const start = window.scrollY;
  const target = Math.max(0, Math.min(
    start + card.getBoundingClientRect().top - (window.innerHeight - card.offsetHeight) / 2,
    document.documentElement.scrollHeight - window.innerHeight,
  ));
  const arrived = await new Promise(resolve => {
    let frame = null, finished = false;
    const startedAt = performance.now();
    const finish = success => {
      if (finished) return;
      finished = true;
      cancelAnimationFrame(frame);
      for (const event of ['wheel', 'touchstart', 'keydown']) window.removeEventListener(event, interrupt);
      cancelCurrent = null;
      resolve(success);
    };
    const interrupt = () => finish(false);
    cancelCurrent = interrupt;
    for (const event of ['wheel', 'touchstart', 'keydown']) window.addEventListener(event, interrupt, { passive: true });
    const step = now => {
      if (!card.isConnected || !isCurrent()) return finish(false);
      const progress = reducedMotion ? 1 : Math.min(1, (now - startedAt) / 750);
      const eased = 1 - Math.pow(1 - progress, 3);
      window.scrollTo({ top: start + (target - start) * eased, behavior: 'instant' });
      if (progress === 1) finish(true);
      else frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  });
  if (!arrived || !card.isConnected || !isCurrent()) return false;
  card.focus({ preventScroll: true });
  card.classList.remove('dx-b50-arrival');
  // Restart the highlight when the user reopens the same settlement.
  void card.offsetWidth;
  card.classList.add('dx-b50-arrival');
  highlightedCard = card;
  highlightTimer = setTimeout(() => {
    card.classList.remove('dx-b50-arrival');
    highlightedCard = null;
  }, 2400);
  return true;
}
