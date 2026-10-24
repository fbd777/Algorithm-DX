/** Shared settlement character, with an optional custom image saved locally. */
const MASCOT_KEY = 'mm-mascot';
export const MASCOT_DEFAULT = '/assets/mm-parts/derakkuma-profile.png';
export const MASCOT_FALLBACK = MASCOT_DEFAULT;
const LEGACY_DEFAULTS = new Set([
  'https://lolicount.top/@ttttt?theme=manosaba-ema&fsize=16&scale=1&unshowf=true&text=%7Bn%7D',
  '/assets/mm-parts/navichara-01-p1-02.png',
  '/assets/mm-parts/chara-placeholder.png',
]);
function resolvedMascot(url) {
  const value = typeof url === 'string' ? url.trim() : '';
  return !value || LEGACY_DEFAULTS.has(value) ? MASCOT_DEFAULT : value;
}
function setImageSource(img, url, alt = '结算角色') {
  const source = resolvedMascot(url);
  img.dataset.character = source === MASCOT_DEFAULT ? 'derakkuma' : 'custom';
  img.alt = source === MASCOT_DEFAULT ? '迪拉熊' : alt;
  img.src = source;
}

export function getMascotUrl() {
  try {
    const value = localStorage.getItem(MASCOT_KEY);
    return resolvedMascot(value);
  } catch {
    return MASCOT_DEFAULT;
  }
}

export function setMascotUrl(url) {
  const value = resolvedMascot(url);
  try {
    // 空的就删掉键，回到默认；这样「恢复默认」和「填了自己的」共用一条路径
    if (!value || value === MASCOT_DEFAULT) localStorage.removeItem(MASCOT_KEY);
    else localStorage.setItem(MASCOT_KEY, value);
  } catch {
    /* 隐私模式下写不进去，当次会话照样能用 */
  }
  document.dispatchEvent(new CustomEvent('mm-mascot-change', { detail: { url: getMascotUrl() } }));
}

/** Custom images fall back to the local bear; no remote image is needed by default. */
export function mascotImage({ className = '', alt = '结算角色', fallback = MASCOT_FALLBACK } = {}) {
  const img = document.createElement('img');
  img.className = className;
  img.alt = alt;
  img.loading = 'lazy';
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  let dead = false; // 已经退到尽头，别再互相触发 error
  const fail = () => {
    img.classList.add('mm-mascot-failed');
    img.alt = '结算角色加载失败，检查一下链接';
    img.removeAttribute('src');
  };
  const show = (url) => {
    if (!url) { dead = true; fail(); return; }
    dead = false;
    img.classList.remove('mm-mascot-failed');
    setImageSource(img, url, alt);
  };
  img.addEventListener('error', () => {
    if (dead) return;
    // 先退回本地迪拉熊；本地素材也没了就藏起来，别留破图
    if (fallback && img.getAttribute('src') !== fallback) { setImageSource(img, fallback, alt); return; }
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

/** 打开结算角色设置，预览图片并保存本地偏好。 */
export function openMascotSettings() {
  if (!settingsDialog) settingsDialog = buildSettings();
  const input = settingsDialog.querySelector('.mm-mascot-input');
  const preview = settingsDialog.querySelector('.mm-mascot-preview');
  input.value = getMascotUrl() === MASCOT_DEFAULT ? '' : getMascotUrl();
  preview.firstChild?.dispatchEvent(new Event('mm-mascot-detach'));
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
    <form method="dialog" class="mm-mascot-form" novalidate>
      <button class="mm-mascot-close" type="submit" aria-label="关闭结算角色设置">×</button>
      <h2 id="mmMascotTitle">结算角色</h2>
      <p class="mm-mascot-hint">
        默认使用迪拉熊。也可以填入自己的角色图片链接；留空或恢复默认即可换回迪拉熊。
      </p>
      <label class="mm-mascot-label" for="mmMascotInput">图片链接</label>
      <input id="mmMascotInput" class="mm-mascot-input" type="url" spellcheck="false"
             placeholder="留空使用迪拉熊" autocomplete="off">
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
    img.alt = '结算角色预览';
    img.referrerPolicy = 'no-referrer';
    setImageSource(img, input.value, '角色预览');
    preview.firstChild?.dispatchEvent(new Event('mm-mascot-detach'));
    preview.replaceChildren(img);
  };

  dialog.querySelector('.mm-mascot-save').addEventListener('click', () => {
    setMascotUrl(input.value);
    dialog.close();
  });
  dialog.querySelector('.mm-mascot-reset').addEventListener('click', () => {
    input.value = '';
    redraw();
  });
  input.addEventListener('input', redraw);
  dialog.addEventListener('close', () => {
    // 关闭时丢弃没保存的编辑，免得下次打开显示的是没生效的内容
    input.value = getMascotUrl() === MASCOT_DEFAULT ? '' : getMascotUrl();
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
