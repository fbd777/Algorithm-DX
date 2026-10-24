/**
 * maimai 官网皮肤的行为层：深色模式开关、移动端菜单开关、回到顶部。
 *
 * 只做这一层需要的行为，不碰 app.js 的数据逻辑；无依赖、原生 ESM。
 *
 * 深色模式（主题的唯一写入口，其它模块只读 dataset.mmTheme）：
 *   · 主题落在 <html data-mm-theme="light|dark">，首屏由各页 <head> 里的一小段脚本先定好，
 *     这里负责开关、记忆（localStorage）、跟随系统，以及下面这些跟着主题走的东西：
 *       开关的 aria-checked 与 title、iframe 背景的主题、
 *       画布重画（发 mm-theme-change）、换皮那一帧的过渡开关。
 *     品牌图标不用 JS：它读 <html> 上的主题走 CSS 背景，首帧就是对的。
 *   · 背景是 iframe 里的官方动态页，换主题不重载它，改发 postMessage 就地换贴图，
 *     官方那套入场动画不会重播。
 */

const THEME_KEY = 'mm-theme';

const prefersDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

function storedTheme() {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === 'dark' || value === 'light' ? value : null;
  } catch {
    return null;
  }
}

const currentTheme = () => (document.documentElement.dataset.mmTheme === 'dark' ? 'dark' : 'light');

const bgFrame = document.querySelector('.mm-bg-frame');

function tellBackground(theme) {
  if (!bgFrame || !bgFrame.contentWindow) return;
  // 背景页认的就是 data-mm-theme 那两个词，见 bg.html 的 message 监听
  bgFrame.contentWindow.postMessage({ mmTheme: theme }, location.origin);
}

function applyTheme(theme, { remember = true, notify = true } = {}) {
  // 换皮那一帧先把过渡关掉：只有一部分卡片/按钮带 transition，不关的话它们会慢半拍，
  // 看上去像「有的卡片没跟着换主题」。两帧后摘掉，之后 hover 之类的过渡照旧。
  const root = document.documentElement;
  root.classList.add('mm-theme-switching');
  root.dataset.mmTheme = theme;
  root.style.colorScheme = theme;
  const button = document.getElementById('mmThemeBtn');
  if (button) {
    button.setAttribute('aria-checked', String(theme === 'dark'));
    button.title = theme === 'dark' ? '切换到浅色模式' : '切换到深色模式';
  }
  if (remember) {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* 隐私模式下写不进去就算了，当次会话照样能用 */
    }
  }
  if (notify) tellBackground(theme);
  // 画布里的图形是 JS 画的，CSS 换皮管不到，交给需要重画的模块自己接
  document.dispatchEvent(new CustomEvent('mm-theme-change', { detail: { theme } }));
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('mm-theme-switching')));
}

// 首屏脚本已经定过主题，这里补齐图标/开关状态，并把主题同步给背景
applyTheme(storedTheme() ?? (prefersDark() ? 'dark' : 'light'), { remember: false });

const themeBtn = document.getElementById('mmThemeBtn');

if (themeBtn) {
  themeBtn.addEventListener('click', () => {
    applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  });
}

// 用户没手动选过时，跟随系统切换
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
  if (!storedTheme()) applyTheme(event.matches ? 'dark' : 'light', { remember: false });
});

// iframe 的 src 放在 data-src 里，这里按当前主题挂上（深色直接带 ?night=1，
// 免得先亮后暗地闪一下）；之后切换主题只发消息，不重载，官方入场动画不会重播。
if (bgFrame) {
  const baseSrc = bgFrame.getAttribute('data-src') || '/bg.html';
  if (!bgFrame.getAttribute('src')) {
    bgFrame.setAttribute('src', currentTheme() === 'dark' ? `${baseSrc}?night=1` : baseSrc);
  }
  bgFrame.addEventListener('load', () => tellBackground(currentTheme()));
}

const menuBtn = document.getElementById('mmMenuBtn');

if (menuBtn) {
  const setOpen = (open) => {
    document.body.classList.toggle('mm-menu-open', open);
    // html 上也挂一份：只锁 body 拦不住 html 那只滚动条，深色面板右上角会露一截浅色滑块
    document.documentElement.classList.toggle('mm-menu-open', open);
    menuBtn.setAttribute('aria-expanded', String(open));
  };
  menuBtn.addEventListener('click', () => setOpen(!document.body.classList.contains('mm-menu-open')));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setOpen(false);
  });
  // 窄屏展开、随后把窗口拉宽的话：菜单按钮这时已经隐藏，锁滚动的那条规则也出了媒体查询，
  // 不收起来就会卡在一个看不见、又关不掉的展开态上
  window.matchMedia('(min-width: 1001px)').addEventListener('change', (event) => {
    if (event.matches) setOpen(false);
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