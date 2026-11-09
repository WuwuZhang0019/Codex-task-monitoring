type DesktopWindow = Window & { __TAURI__?: { core: { invoke: <T>(command:string,args?:Record<string,unknown>)=>Promise<T> } } };
export const isDesktop = () => !!(window as DesktopWindow).__TAURI__;
export function desktopInvoke<T>(command:string,args?:Record<string,unknown>):Promise<T> {
  const runtime=(window as DesktopWindow).__TAURI__;
  if(!runtime) return Promise.reject(new Error('桌面宿主未就绪'));
  return runtime.core.invoke<T>(command,args);
}
