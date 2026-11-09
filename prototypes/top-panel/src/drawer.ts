import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export async function initializeDrawer() {
  document.body.classList.add("native-drawer");
  const app = document.querySelector<HTMLDivElement>("#app")!;
  app.innerHTML =
    '<section class="island"><div class="content"></div></section>';
  const content = app.querySelector<HTMLElement>(".content")!;
  const send = (message: string) => invoke("drawer_message", { message });
  await listen<string>("drawer-view", (event) => {
    content.innerHTML = event.payload;
  });
  await listen<boolean>("drawer-visibility", (event) => {
    document.body.classList.toggle("drawer-open", event.payload);
  });
  app.addEventListener("mouseenter", () => void send("enter"));
  app.addEventListener("mouseleave", () => void send("leave"));
  app.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
      "button",
    );
    if (button) void send(button.dataset.event ?? button.id);
  });
  await send("ready");
}
