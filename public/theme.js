/**
 * maimai 官网皮肤的两件小事：移动端菜单开关、回到顶部。
 *
 * 只做这一层需要的行为，不碰 app.js 的数据逻辑；无依赖、原生 ESM。
 */

const menuBtn = document.getElementById('mmMenuBtn');

if (menuBtn) {
  const setOpen = (open) => {
    document.body.classList.toggle('mm-menu-open', open);
    menuBtn.setAttribute('aria-expanded', String(open));
  };
  menuBtn.addEventListener('click', () => setOpen(!document.body.classList.contains('mm-menu-open')));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setOpen(false);
  });
  // 菜单里点走一项就收起来，否则新页面加载前会停在展开态
  document.querySelectorAll('.site-header .nav a').forEach((link) => {
    link.addEventListener('click', () => setOpen(false));
  });
}

const topLink = document.querySelector('.mm-top');

if (topLink) {
  const sync = () => topLink.classList.toggle('off', window.scrollY < 600);
  sync();
  window.addEventListener('scroll', sync, { passive: true });
  topLink.addEventListener('click', (event) => {
    event.preventDefault();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}