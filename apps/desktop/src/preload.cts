import { contextBridge, ipcRenderer } from "electron";

/** The only surface the renderer can reach. No Node access in the UI. */
contextBridge.exposeInMainWorld("memento", {
  initialProject: () => ipcRenderer.invoke("app:initialProject"),
  openProject: (dir?: string) => ipcRenderer.invoke("project:open", dir),
  listTests: () => ipcRenderer.invoke("tests:list"),
  readFile: (p: string) => ipcRenderer.invoke("file:read", p),
  writeFile: (p: string, content: string) => ipcRenderer.invoke("file:write", p, content),
  validate: (p: string, content: string) => ipcRenderer.invoke("file:validate", p, content),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveAi: (ai: unknown) => ipcRenderer.invoke("settings:saveAi", ai),
  setSecret: (name: string, value: string | null) => ipcRenderer.invoke("secrets:set", name, value),
  run: (opts: unknown) => ipcRenderer.invoke("run:start", opts),
  stop: () => ipcRenderer.invoke("run:stop"),
  openTrace: (p: string) => ipcRenderer.invoke("trace:open", p),
  reveal: (p: string) => ipcRenderer.invoke("shell:reveal", p),
  onRunEvent: (cb: (e: { channel: string; payload: unknown }) => void) => {
    const handler = (_: unknown, e: { channel: string; payload: unknown }) => cb(e);
    ipcRenderer.on("run:event", handler);
    return () => ipcRenderer.removeListener("run:event", handler);
  },
});
