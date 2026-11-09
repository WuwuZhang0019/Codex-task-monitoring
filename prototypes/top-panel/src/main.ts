import "./styles.css";
import { invoke, isTauri } from "@tauri-apps/api/core";
let notificationUntil = 0;
let pinned = false,
  hovered = false,
  expanded = false,
  unread = 0;
let hoverTimer: ReturnType<typeof setTimeout>,
  leaveTimer: ReturnType<typeof setTimeout>,
  eventTimer: ReturnType<typeof setTimeout>,
  pending: ReturnType<typeof setTimeout>;
let frame = 0,
  width = 600,
  height = 38;
const app = document.querySelector<HTMLDivElement>("#app")!;
const names = [
  "现场核对",
  "桌面宿主",
  "会话发现",
  "方案草稿",
  "Codex 连接",
  "顶部面板",
  "组合验收",
];
app.innerHTML = `<section class="island"><button class="compact" aria-expanded="false" title="悬停预览 · 点击固定"><span class="brand">⌘</span><b>任务航线</b><i></i><span id="status">D06 顶部面板</span><span class="live">●</span><span id="count">1 执行</span><span id="unread"></span><span>⌄</span></button><div class="content"><header><div><div class="eyebrow">CODEX TASK MONITOR <em>模拟演示</em></div><h1>每一步，都有清晰的去向。</h1><p>桌面工作台与 Codex 连接 <span>/ 开发路线 D01—D07</span></p></div><nav><button id="pin">○ 固定展开</button><button id="collapse" title="收起">⌃</button><button id="quit" title="退出演示">×</button></nav></header><div class="summary"><span id="summary">● 1 条任务线正在执行</span><span id="progress">4 / 7 站已验收</span><span>2 站等待依赖</span><small>2026-11-09 · 固定样例</small></div><article class="route-card"><div class="route-heading"><b>━ 桌面化主线</b><span class="tag" id="route-status">D06 · 正在执行</span></div><div class="route" role="list">${names.map((name, index) => `<div class="station ${index < 4 ? "accepted" : index === 5 ? "running" : "waiting"}" role="listitem"><div class="rail"><span class="node">${index < 4 ? "✓" : index === 5 ? "●" : ""}</span></div><b>D0${index + 1}</b><span>${name}</span><small>${index < 4 ? "验收通过" : index === 5 ? "正在执行" : "等待依赖"}</small></div>`).join("")}</div></article><div class="bottom"><article><div class="eyebrow">CURRENT STATION</div><h2>D06 顶部常驻路线面板</h2><p>紧凑条、悬停路线与完成下拉提醒</p><div class="source"><strong>C</strong><div>面板交互演示<small>固定模拟数据 · 本地独立原型</small></div><span class="tag">演示中</span></div></article><article class="event-card" aria-live="polite"><div class="eyebrow">ACTIVITY <em id="event-label">等待模拟事件</em></div><h2 id="event-title">路线已就绪</h2><p id="event-description">点击下方按钮，预览不同阶段的自动下拉提醒。</p><button id="read" class="text">标记已读并收起 ↗</button></article></div><footer><span>演示控制 <small>3 秒后触发，便于移出鼠标</small></span><nav><button data-event="ended">模拟执行结束</button><button data-event="accepted" class="primary">模拟验收通过</button><button id="reset">重置</button></nav></footer><div class="footnote">红灯 = 有效验收通过　绿灯 = 正在执行　暗灯 = 等待 / 待核验</div><div id="error" role="alert"></div></div></section>`;
const get = (query: string) => app.querySelector<HTMLElement>(query)!;
const miniRoute = document.createElement("span");
miniRoute.className = "mini-route";
miniRoute.setAttribute("role", "img");
get("#status").after(miniRoute);
function syncMiniRoute() {
  const descriptions: string[] = [];
  miniRoute.replaceChildren();
  app.querySelectorAll<HTMLElement>(".station").forEach((station, index) => {
    const marker = document.createElement("span");
    marker.className = station.className.replace("station", "mini-station");
    const label = `D0${index + 1}`;
    const description = `${label} ${names[index]} ${station.querySelector("small")!.textContent}`;
    marker.title = description;
    marker.innerHTML = `<span class="mini-node"></span><span>${label}</span>`;
    miniRoute.append(marker);
    descriptions.push(description);
  });
  miniRoute.setAttribute("aria-label", descriptions.join("，"));
}
syncMiniRoute();
function text(query: string, value: string) {
  get(query).textContent = value;
}
function resize(open: boolean) {
  cancelAnimationFrame(frame);
  if (!isTauri()) return;
  const startWidth = width,
    startHeight = height,
    started = performance.now();
  const duration = matchMedia("(prefers-reduced-motion: reduce)").matches
    ? 1
    : 220;
  const tick = async () => {
    const progress = Math.min(1, (performance.now() - started) / duration),
      ease = 1 - Math.pow(1 - progress, 3);
    width = startWidth + ((open ? 920 : 600) - startWidth) * ease;
    height = startHeight + ((open ? 560 : 38) - startHeight) * ease;
    try {
      await invoke("resize_panel", { width, height });
      if (progress < 1 && expanded === open)
        frame = requestAnimationFrame(tick);
    } catch (error) {
      text("#error", `窗口调整失败 ${String(error)}`);
    }
  };
  frame = requestAnimationFrame(tick);
}
function show(open: boolean) {
  expanded = open;
  app.classList.toggle("expanded", open);
  get(".compact").setAttribute("aria-expanded", String(open));
  resize(open);
}
function pin(value: boolean) {
  pinned = value;
  text("#pin", pinned ? "● 已固定" : "○ 固定展开");
  get("#pin").setAttribute("aria-pressed", String(value));
}
function collapse() {
  notificationUntil = 0;
  clearTimeout(eventTimer);
  pin(false);
  show(false);
}
app.addEventListener("mouseenter", () => {
  hovered = true;
  clearTimeout(leaveTimer);
  hoverTimer = setTimeout(() => show(true), 180);
});
app.addEventListener("mouseleave", () => {
  hovered = false;
  clearTimeout(hoverTimer);
  leaveTimer = setTimeout(() => {
    if (!pinned && Date.now() >= notificationUntil) show(false);
  }, 350);
});
get(".compact").onclick = () => {
  pin(!pinned);
  show(true);
};
get("#pin").onclick = () => pin(!pinned);
get("#collapse").onclick = collapse;
get("#quit").onclick = async () => {
  if (isTauri()) await invoke("quit_demo");
  else collapse();
};
get("#read").onclick = () => {
  unread = 0;
  text("#unread", "");
  collapse();
};
function emit(accepted: boolean) {
  notificationUntil = Date.now() + 8000;
  unread++;
  text("#unread", String(unread));
  text("#event-label", accepted ? "本站通过" : "待核验");
  text("#event-title", accepted ? "D06 本站验收通过" : "执行结束，等待核验");
  text(
    "#event-description",
    accepted
      ? "模拟证据核验有效。D07 仍等待 D05，任务线继续进行。"
      : "已收到本轮执行回执。本站仍待独立证据核验。",
  );
  get(".event-card").classList.toggle("passed", accepted);
  get(".station:nth-child(6)").className =
    `station ${accepted ? "accepted" : "waiting"}`;
  text(".station:nth-child(6) small", accepted ? "验收通过" : "待核验");
  text(".station:nth-child(6) .node", accepted ? "✓" : "");
  syncMiniRoute();
  text("#status", accepted ? "D06 本站验收通过" : "D06 执行结束 · 待核验");
  text("#count", "0 执行");
  get(".compact .live").style.color = accepted ? "#ef7872" : "#888";
  text("#summary", accepted ? "本站验收通过" : "本轮执行结束 · 等待核验");
  text("#progress", `${accepted ? 5 : 4} / 7 站已验收`);
  text("#route-status", accepted ? "D06 · 验收通过" : "D06 · 待核验");
  show(true);
  clearTimeout(eventTimer);
  eventTimer = setTimeout(() => {
    if (!hovered && !pinned) show(false);
  }, 8000);
}
app.querySelectorAll<HTMLButtonElement>("[data-event]").forEach(
  (button) =>
    (button.onclick = () => {
      clearTimeout(pending);
      clearTimeout(eventTimer);
      pin(false);
      text("#event-title", "3 秒后触发模拟提醒");
      text("#event-description", "可移出鼠标，在其他软件中继续输入。");
      pending = setTimeout(
        () => emit(button.dataset.event === "accepted"),
        3000,
      );
    }),
);
get("#reset").onclick = () => location.reload();
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") collapse();
});
show(false);
