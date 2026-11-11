// 日期：2026-11-11。固定宿主内同一进度驱动视觉与原生命中区域，反向从已应用帧继续。
import { useEffect, useRef } from 'react';
import { desktopInvoke, isDesktop } from './desktop';

type Bounds = { width: number; height: number; compactWidth: number; progress?: number };
let frameSequence = Date.now() * 1000;
export function useIslandMotion(floating: boolean, expanded: boolean, pinned: boolean, onError: (text: string) => void) {
  const surface = useRef<HTMLDivElement>(null);
  const progress = useRef(0);
  const target = useRef(expanded ? 1 : 0);
  const errorHandler = useRef(onError);
  errorHandler.current = onError;
  target.current = expanded ? 1 : 0;
  const wake = useRef<() => void>(() => {});

  useEffect(() => {
    if (!floating) return;
    let stopped = false, running = false, needsConfigure = true, failureReported = false;
    let bounds: Bounds;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const nextFrame = () => new Promise<number>(resolve => requestAnimationFrame(resolve));
    function paint(value: number) {
      const node = surface.current;
      if (!node) return;
      const width = bounds.compactWidth + (bounds.width - bounds.compactWidth) * value;
      const height = 38 + (bounds.height - 38) * value;
      const opacity = Math.max(0, Math.min(1, (value - .45) / .55));
      node.style.setProperty('--lp-host-width', `${bounds.width}px`);
      node.style.setProperty('--lp-host-height', `${bounds.height}px`);
      node.style.setProperty('--lp-compact-width', `${bounds.compactWidth}px`);
      node.style.setProperty('--lp-shape-width', `${width}px`);
      node.style.setProperty('--lp-shape-height', `${height}px`);
      node.style.setProperty('--lp-shape-inset', `${(bounds.width - width) / 2}px`);
      node.style.setProperty('--lp-shape-bottom', `${bounds.height - height}px`);
      node.style.setProperty('--lp-shape-radius', `${18 + 2 * value}px`);
      node.style.setProperty('--lp-content-opacity', String(opacity));
      node.style.setProperty('--lp-content-offset', `${reduced.matches ? 0 : -6 * (1 - opacity)}px`);
      node.dataset.progress = value.toFixed(4);
      node.dataset.motion = value === target.current ? (value ? 'expanded' : 'compact') : (target.current ? 'opening' : 'closing');
    }
    async function apply(value: number) {
      // 只有一个在途帧；旧目标的已发送帧先落地，再从该进度反向，绝不并发排队。
      if (isDesktop()) {
        const result = await desktopInvoke<{ progress: number }>('panel_frame', { frame: ++frameSequence, progress: value });
        value = result.progress;
      }
      if (!stopped) { progress.current = value; paint(value); }
    }
    async function pump() {
      if (stopped || running) return;
      running = true;
      let to = target.current, from = progress.current, start = performance.now();
      let recovered = false;
      try {
        while (!stopped) {
          try {
            if (needsConfigure) {
              needsConfigure = false;
              const nextBounds = isDesktop() ? await desktopInvoke<Bounds>('panel_window', { expanded: false, pinned })
                : { width: Math.max(1, Math.min(960, innerWidth - 32)), height: Math.max(38, Math.min(678, innerHeight - 16)), compactWidth: Math.min(600, Math.max(1, innerWidth - 32)) };
              if (stopped) break;
              bounds = nextBounds;
              await apply(nextBounds.progress ?? progress.current);
              to = target.current; from = progress.current; start = performance.now();
            }
            if (needsConfigure) continue;
            if (progress.current === target.current) {
              if (failureReported) { failureReported = false; errorHandler.current('动效同步已恢复'); }
              break;
            }
            const now = await nextFrame();
            if (stopped) break;
            if (needsConfigure) continue;
            if (to !== target.current) { to = target.current; from = progress.current; start = now; }
            const duration = reduced.matches ? 60 : (to ? 280 : 240) * Math.max(.25, Math.abs(to - from));
            const time = Math.min(1, (now - start) / duration);
            const eased = to ? 1 - Math.pow(1 - time, 3) : time * time * (3 - 2 * time);
            await apply(time === 1 ? to : from + (to - from) * eased);
          } catch (error) {
            if (stopped) break;
            if (!recovered) {
              recovered = true; needsConfigure = true;
              await new Promise(resolve => setTimeout(resolve, 100));
              continue;
            }
            failureReported = true;
            errorHandler.current(`动效同步失败，请点击顶部条重试：${String(error)}`);
            break;
          }
        }
      } finally { running = false; }
    }
    // 配置与帧更新共用单一串行驱动；动画中的环境变化只标记，下一帧前重算。
    wake.current = () => void pump();
    const resized = () => { needsConfigure = true; wake.current(); };
    window.addEventListener('resize', resized);
    document.documentElement.classList.add('lp-floating-page');
    void pump();
    return () => { stopped = true; wake.current = () => {}; window.removeEventListener('resize', resized); document.documentElement.classList.remove('lp-floating-page'); };
  }, [floating]);
  useEffect(() => { wake.current(); }, [expanded]);
  useEffect(() => {
    if (floating && isDesktop()) void desktopInvoke('panel_pin', { pinned }).catch(error => errorHandler.current(`置顶设置失败：${String(error)}`));
  }, [floating, pinned]);
  return { surface, progress, retry: () => wake.current() };
}
