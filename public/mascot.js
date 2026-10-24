/**
 * 看板娘：一处全局设置，一处展示。
 *
 * 图片来自 lolicount.top —— 那个站按 URL 参数出图（`@用户名` 选人、`theme` 选主题、
 * `scale`/`fsize` 调大小、`text` 是计数文字）。直接用 <img> 引用就行，不走 fetch：
 * <img> 不会碰上跨域，站上那边换图我们也不用改代码。
 *
 * 链路：设置弹窗写 localStorage（mm-mascot）→ 发 mm-mascot-change →
 * 要展示的地方（目前是结算弹窗）自己重画。无依赖，原生 ESM，和 theme.js 一个路数。
 *
 * 站点：https://lolicount.top —— 设置页里给出入口，让用户自己去挑。
 */

const MASCOT_KEY = 'mm-mascot';

/** 默认看板娘：一串普通的 lolicount.top 图片链接，用户随时可以换成自己的 */
export const MASCOT_DEFAULT =
  'https://lolicount.top/@ttttt?theme=manosaba-ema&fsize=16&scale=1&unshowf=true&text=%7Bn%7D';

/** 站上「获取链接」的入口，设置页引导用户去这里挑 */
const MASCOT_SITE = 'https://lolicount.top';

/**
 * 远端图挂了就退回这张本地立绘（仓库自带，不联外网）。
 *
 * 不是随便找的占位图：这是客户端里结算画面那位导航角色的立绘
 * `UI_Navichara_01_P1_02`（524×812 RGBA，全身站姿、底色全透明）——
 * 结算画面的 `Null_NavicharaRoot` 挂的就是 `Navi_Default` 这一族。
 * 同族的 02/03/04/05 是同一姿势的几帧表情差分，02 是两眼睁开、
 * 站得最"正"的那一帧。
 *
 * 之前挑过 `UI_ADV_Img_chara155_01_01`（616×1160，撑伞的紫发角色），
 * 那张本身没问题，但她是淡紫配白，放在成绩板那块近白玻璃后面整片糊掉，
 * 立绘就"读"不出来了；这一位是红裙 + 黑色条纹袜，浅底板上反差够，
 * 隔着板子还看得见人。（同族的 `UI_ADV_Img_chara155_01_shadow`
 * 证明 chara155 那族也是"站到背景上"的图，只是不适合这个底板。）
 *
 * 出图路子见 `scripts/extract-result-assets.py`（UnityPy 读 resources.assets
 * 的 Texture2D），这里只放结果。
 */
export const MASCOT_FALLBACK = '/assets/mm-parts/navichara-01-p1-02.png';

export function getMascotUrl() {
  try {
    const value = localStorage.getItem(MASCOT_KEY);
    return value && value.trim() ? value.trim() : MASCOT_DEFAULT;
  } catch {
    return MASCOT_DEFAULT;
  }
}

export function setMascotUrl(url) {
  const value = typeof url === 'string' ? url.trim() : '';
  try {
    // 空的就删掉键，回到默认；这样「恢复默认」和「填了自己的」共用一条路径
    if (!value || value === MASCOT_DEFAULT) localStorage.removeItem(MASCOT_KEY);
    else localStorage.setItem(MASCOT_KEY, value);
  } catch {
    /* 隐私模式下写不进去，当次会话照样能用 */
  }
  document.dispatchEvent(new CustomEvent('mm-mascot-change', { detail: { url: getMascotUrl() } }));
}

/**
 * 造一个看板娘 <img>。
 *
 * lolicount.top 给的是 SVG，浏览器能直接在 <img> 里画；这里不解析它的内容，
 * 将来它换成别的位图格式也照用。
 *
 * 三级降级：用户链接 → 本地占位图（fallback）→ 彻底藏起来。
 * 前两级任何一级失败都不会露出浏览器的破图标；最后一级加 .mm-mascot-failed，
 * 由 mascot.css 设成 display:none —— 布局照样是完整的一块，只是里面没有图。
 */
export function mascotImage({ className = '', alt = '看板娘', fallback = MASCOT_FALLBACK } = {}) {
  const img = document.createElement('img');
  img.className = className;
  img.alt = alt;
  img.loading = 'lazy';
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  let dead = false; // 已经退到尽头，别再互相触发 error
  const fail = () => {
    img.classList.add('mm-mascot-failed');
    img.alt = '看板娘加载失败，检查一下链接';
    img.removeAttribute('src');
  };
  const show = (url) => {
    if (!url) { dead = true; fail(); return; }
    dead = false;
    img.classList.remove('mm-mascot-failed');
    img.src = url;
  };
  img.addEventListener('error', () => {
    if (dead) return;
    // 先退回本地占位图；占位图自己也没了就藏起来，别留破图
    if (fallback && img.getAttribute('src') !== fallback) { img.src = fallback; return; }
    dead = true;
    fail();
  });
  show(getMascotUrl());
  // 设置改了就换图；同一个元素上只挂一次
  const onchange = (event) => show(event.detail?.url || getMascotUrl());
  img.addEventListener('mm-mascot-detach', () => document.removeEventListener('mm-mascot-change', onchange));
  document.addEventListener('mm-mascot-change', onchange);
  return img;
}

let settingsDialog = null;

/** 打开看板娘设置：一个链接输入框 + 实时预览 + 去站上挑的引导 */
export function openMascotSettings() {
  if (!settingsDialog) settingsDialog = buildSettings();
  const input = settingsDialog.querySelector('.mm-mascot-input');
  const preview = settingsDialog.querySelector('.mm-mascot-preview');
  input.value = getMascotUrl();
  preview.replaceChildren(mascotImage({ className: 'mm-mascot-preview-img' }));
  if (!settingsDialog.open) settingsDialog.showModal();
  input.focus();
  input.select();
}

function buildSettings() {
  const dialog = document.createElement('dialog');
  dialog.className = 'mm-mascot-dialog';
  dialog.setAttribute('aria-labelledby', 'mmMascotTitle');
  dialog.innerHTML = `
    <form method="dialog" class="mm-mascot-form">
      <button class="mm-mascot-close" type="submit" aria-label="关闭看板娘设置">×</button>
      <h2 id="mmMascotTitle">看板娘</h2>
      <p class="mm-mascot-hint">
        图片来自 <a href="${MASCOT_SITE}" target="_blank" rel="noopener noreferrer">lolicount.top ↗</a>：
        在那个站点里挑好角色和主题，复制它给你的图片链接，粘贴到下面即可。链接里
        <code>@名字</code> 选角色、<code>theme</code> 选主题、<code>scale</code> 调节大小。
      </p>
      <label class="mm-mascot-label" for="mmMascotInput">图片链接</label>
      <input id="mmMascotInput" class="mm-mascot-input" type="url" spellcheck="false"
             placeholder="${MASCOT_DEFAULT}" autocomplete="off">
      <div class="mm-mascot-preview" aria-label="预览"></div>
      <div class="mm-mascot-actions">
        <button type="button" class="btn btn-ghost mm-mascot-reset">恢复默认</button>
        <button type="button" class="btn btn-primary mm-mascot-save">保存</button>
      </div>
    </form>`;
  const input = dialog.querySelector('.mm-mascot-input');
  const preview = dialog.querySelector('.mm-mascot-preview');

  const redraw = () => {
    // 预览走同一个地址，所见即所得；这里不写 localStorage，避免边打字边存进半截链接
    const img = document.createElement('img');
    img.className = 'mm-mascot-preview-img';
    img.alt = '看板娘预览';
    img.referrerPolicy = 'no-referrer';
    img.src = input.value.trim() || MASCOT_DEFAULT;
    preview.replaceChildren(img);
  };

  dialog.querySelector('.mm-mascot-save').addEventListener('click', () => {
    setMascotUrl(input.value);
    dialog.close();
  });
  dialog.querySelector('.mm-mascot-reset').addEventListener('click', () => {
    input.value = MASCOT_DEFAULT;
    redraw();
  });
  input.addEventListener('input', redraw);
  dialog.addEventListener('close', () => {
    // 关闭时丢弃没保存的编辑，免得下次打开显示的是没生效的内容
    input.value = getMascotUrl();
  });
  document.body.append(dialog);
  return dialog;
}

const button = document.getElementById('mmMascotBtn');
if (button) button.addEventListener('click', () => openMascotSettings());

// ?mascot=1 直接打开设置：截图、演示、自动化测试都用得上
if (new URLSearchParams(location.search).get('mascot') === '1') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => openMascotSettings());
  else openMascotSettings();
}
