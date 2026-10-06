const trigger = document.getElementById('supportProject');
const dialog = document.getElementById('supportDialog');

trigger.addEventListener('click', () => dialog.showModal());
dialog.addEventListener('close', () => trigger.focus({ preventScroll: true }));
// Native dialog provides Escape dismissal and keeps keyboard focus inside.
dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right ||
      event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
});
