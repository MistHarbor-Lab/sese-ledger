// core/host-send-indicator.ts
// 推进中发送图标：剧情推进的规划请求在跑时，把酒馆输入栏右侧的发送纸飞机
// 临时替换为「航迹三点」图标；请求结束（成功 / 失败 / 终止）自动还原。
//
// 生命周期只由 index.ts 的 notifyProgress / clearProgress 驱动——与现有
// 「剧情推进规划中…（点击终止）」toast 同一个 choke point。**不跟 toast 的
// 自动隐去走**：通知 3 秒后消失，图标仍保留到请求真正结束。
//
// 口径：
// - 只改父页面 #send_but 的视觉，不改发送语义；找不到按钮 / 文档一律静默跳过。
// - 颜色全部 currentColor，尺寸 1em，跟随酒馆主题与 --bottomFormIconSize。
// - 空闲零开销：不轮询、不加常驻监听；首次 start 时才注入 <style>。
// - 点击终止（可选）：running 期间在 document capture 阶段拦下 #send_but 的 click，
//   复用推进的 onAbort；同时避免规划中重复点发送。
// - dispose 清 class / SVG / 本模块注入的 style / title / aria-busy。

const SVG_NS = 'http://www.w3.org/2000/svg';
const STYLE_ID = 'sl-plot-send-indicator-style';
const BUTTON_CLASS = 'sl-plot-running';
const ICON_CLASS = 'sl-plot-indicator-icon';

/** FA 6.5.2 solid paper-plane——与酒馆发送按钮的原图标同一条路径。 */
const PLANE_PATH = 'M498.1 5.6c10.1 7 15.4 19.1 13.5 31.2l-64 416c-1.5 9.7-7.4 18.2-16 23s-18.9 5.4-28 1.6L284 427.7l-68.5 74.1c-8.9 9.7-22.9 12.9-35.2 8.1S160 493.2 160 480V396.4c0-4 1.5-7.8 4.2-10.7L331.8 202.8c5.8-6.3 5.6-16-.4-22s-15.7-6.4-22-.7L106 360.8 17.7 316.6C7.1 311.3 .3 300.7 0 288.9s5.9-22.8 16.1-28.7l448-256c10.7-6.1 23.9-5.5 34 1.4z';

/** 航迹三点：纸飞机缩到右上方，左下留出三点尾迹（与方案稿 A 逐字一致）。 */
const ICON_INNER =
  `<g class="sl-plot-plane" transform="translate(96 8) scale(0.78)"><path d="${PLANE_PATH}"/></g>` +
  '<g class="sl-plot-dots">' +
  '<circle class="sl-plot-dot d1" cx="40" cy="488" r="20"/>' +
  '<circle class="sl-plot-dot d2" cx="108" cy="436" r="26"/>' +
  '<circle class="sl-plot-dot d3" cx="176" cy="384" r="32"/>' +
  '</g>';

const CSS = `
#send_but.sl-plot-running::before{content:none !important}
#send_but.sl-plot-running>i{display:none !important}
#send_but.sl-plot-running>svg.sl-plot-indicator-icon{display:block;width:1em;height:1em;fill:currentColor;overflow:visible;animation:sl-plot-fly 1.35s ease-in-out infinite}
#send_but.sl-plot-running .sl-plot-dot{opacity:.24;animation:sl-plot-dot 1.35s ease-in-out infinite}
#send_but.sl-plot-running .sl-plot-dot.d1{animation-delay:0s}
#send_but.sl-plot-running .sl-plot-dot.d2{animation-delay:.17s}
#send_but.sl-plot-running .sl-plot-dot.d3{animation-delay:.34s}
@keyframes sl-plot-fly{0%,100%{transform:translate(0,0)}50%{transform:translate(.055em,-.055em)}}
@keyframes sl-plot-dot{0%,100%{opacity:.22}36%{opacity:1}72%{opacity:.22}}
@media (prefers-reduced-motion:reduce){
  #send_but.sl-plot-running>svg.sl-plot-indicator-icon{animation:none !important}
  #send_but.sl-plot-running .sl-plot-dot{animation:none !important;opacity:1}
}
`;

interface PrevState {
  title: string | null;
  busy: string | null;
  hadBusy: boolean;
}

interface SendButton extends HTMLElement {
  __sl_plot_send_prev?: PrevState;
}

export interface HostSendIndicator {
  /** 显示「推进中」图标；onAbort 存在时，点击发送按钮 = 终止本次推进。 */
  start(onAbort?: () => void): void;
  /** 还原发送按钮（幂等）。 */
  stop(): void;
  /** 卸载：还原并移除本模块注入的样式（幂等）。 */
  dispose(): void;
}

export function createHostSendIndicator(deps: { getDocument(): Document | null }): HostSendIndicator {
  let doc: Document | null = null;
  let button: SendButton | null = null;
  let svg: SVGSVGElement | null = null;
  let style: HTMLStyleElement | null = null;
  let styleOwned = false;
  let running = false;
  let onAbort: (() => void) | null = null;
  let clickHandler: ((e: Event) => void) | null = null;
  let clickDoc: Document | null = null;

  /** 首次使用时注入一次；找到旧实例留下的样式则复用并刷新内容（热更新不换版）。 */
  function ensureStyle(d: Document): void {
    try {
      const existing = d.getElementById(STYLE_ID) as HTMLStyleElement | null;
      if (existing) {
        existing.textContent = CSS;
        // 只有本实例创建过同一个元素才继续持有；找到的是上一实例/崩溃残留则不归本实例删。
        if (existing !== style) styleOwned = false;
        style = existing;
        return;
      }
      const el = d.createElement('style');
      el.id = STYLE_ID;
      el.textContent = CSS;
      const host = d.head || d.documentElement;
      if (!host) return;
      host.appendChild(el);
      style = el;
      styleOwned = true;
    } catch (_e) {
      style = null;
      styleOwned = false;
    }
  }

  /** 内联 SVG（无外部资源）；构造失败返回 null，调用方据此放弃替换、保留原图标。 */
  function buildIcon(d: Document): SVGSVGElement | null {
    try {
      const el = d.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
      el.setAttribute('viewBox', '0 0 512 512');
      el.setAttribute('width', '1em');
      el.setAttribute('height', '1em');
      el.setAttribute('fill', 'currentColor');
      el.setAttribute('class', ICON_CLASS);
      el.setAttribute('aria-hidden', 'true');
      el.innerHTML = ICON_INNER;
      return el;
    } catch (_e) {
      return null;
    }
  }

  function unbindAbort(): void {
    if (clickHandler && clickDoc) {
      try { clickDoc.removeEventListener('click', clickHandler, true); } catch (_e) { /* ignore */ }
    }
    clickHandler = null;
    clickDoc = null;
  }

  /** capture 阶段挂在 document 上：先于酒馆 #send_but 的 click 处理器执行。 */
  function bindAbort(d: Document): void {
    if (clickHandler) return;
    clickHandler = (e: Event) => {
      if (!running) return;
      const target = e.target as Element | null;
      let hit = false;
      try { hit = !!target && typeof target.closest === 'function' && !!target.closest('#send_but'); } catch (_e) { /* ignore */ }
      if (!hit) return;
      try { e.preventDefault(); } catch (_e) { /* ignore */ }
      try { e.stopImmediatePropagation(); } catch (_e) { /* ignore */ }
      const cb = onAbort;
      stop();
      if (cb) { try { cb(); } catch (_e) { /* ignore */ } }
    };
    d.addEventListener('click', clickHandler, true);
    clickDoc = d;
  }

  function stop(): void {
    running = false;
    onAbort = null;
    unbindAbort();
    const b = button || (doc ? (doc.getElementById('send_but') as SendButton | null) : null);
    try {
      if (b) {
        const hadOurs = b.classList.contains(BUTTON_CLASS) || !!b.querySelector('svg.' + ICON_CLASS);
        b.classList.remove(BUTTON_CLASS);
        const prev = b.__sl_plot_send_prev;
        if (prev) {
          if (prev.title == null) b.removeAttribute('title'); else b.setAttribute('title', prev.title);
          if (prev.hadBusy) {
            if (prev.busy != null) b.setAttribute('aria-busy', prev.busy);
          } else {
            b.removeAttribute('aria-busy');
          }
          delete b.__sl_plot_send_prev;
        } else if (hadOurs) {
          // 旧实例残留但没有保存态：至少摘掉本模块加的 aria-busy；title 无法还原就不动。
          b.removeAttribute('aria-busy');
        }
      }
      const icon = svg || (b ? (b.querySelector('svg.' + ICON_CLASS) as SVGSVGElement | null) : null);
      if (icon && icon.parentNode) icon.parentNode.removeChild(icon);
    } catch (_e) { /* ignore */ }
    svg = null;
    button = null;
    doc = null;
  }

  return {
    start(abort?: () => void) {
      try {
        const d = deps.getDocument();
        if (!d) return;
        const btn = d.getElementById('send_but') as SendButton | null;
        if (!btn) return;
        doc = d;
        button = btn;
        const nextAbort = typeof abort === 'function' ? abort : null;
        if (running) {
          // 同一轮重复通知：只更新终止回调，不重复插图标。
          onAbort = nextAbort;
          if (onAbort) bindAbort(d); else unbindAbort();
          return;
        }
        ensureStyle(d);
        if (!style) return; // 样式注入失败：不能只插 SVG（会与 FA 字形并存）
        // 清掉上一实例崩溃/未 stop 留下的图标，避免双图标。
        const stale = btn.querySelector('svg.' + ICON_CLASS);
        if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
        const icon = buildIcon(d);
        if (!icon) return;
        btn.appendChild(icon);
        svg = icon;
        if (!btn.__sl_plot_send_prev) {
          btn.__sl_plot_send_prev = {
            title: btn.getAttribute('title'),
            busy: btn.getAttribute('aria-busy'),
            hadBusy: btn.hasAttribute('aria-busy'),
          };
        }
        btn.classList.add(BUTTON_CLASS);
        btn.setAttribute('aria-busy', 'true');
        btn.setAttribute('title', nextAbort ? '剧情推进中…（点击终止）' : '剧情推进中…');
        running = true;
        onAbort = nextAbort;
        if (onAbort) bindAbort(d);
      } catch (_e) {
        // 视觉增强失败不得影响推进本身。
      }
    },

    stop,

    dispose() {
      stop();
      try {
        if (styleOwned && style && style.parentNode) style.parentNode.removeChild(style);
      } catch (_e) { /* ignore */ }
      style = null;
      styleOwned = false;
    },
  };
}
