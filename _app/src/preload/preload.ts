// The only bridge between the window (sandboxed, no Node) and the app.
import { contextBridge, ipcRenderer } from "electron";
import { makeApi } from "../shared/make-api";

const kindArg = process.argv.find((a) => a.startsWith("--window-kind="));

const api = makeApi({
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  on: (event, cb) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on(`event:${event}`, listener);
    return () => ipcRenderer.removeListener(`event:${event}`, listener);
  },
  windowKind: kindArg ? kindArg.slice("--window-kind=".length) : "main",
  platform: process.platform,
});

contextBridge.exposeInMainWorld("conversations", api);
