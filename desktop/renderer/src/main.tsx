import { createRoot } from "react-dom/client";
import { App } from "./App";
import { PopoverHost } from "./PopoverHost";
import { MessageFloat } from "./components/MessageFloat";
import "./globals.css";

const el = document.getElementById("root");
if (el === null) throw new Error("#root not found");

// 弹层子窗口：主进程用 ?popover=<id> 打开同一个 bundle，这里分流渲染对应弹层内容。
const popoverId = new URLSearchParams(window.location.search).get("popover");
// 独立消息弹窗：主进程用 ?msg-window=1 加载同一 bundle，渲染 MessageFloat。
const msgWindow = new URLSearchParams(window.location.search).get("msg-window");

if (msgWindow === "1") {
  createRoot(el).render(<MessageFloat />);
} else if (popoverId !== null) {
  createRoot(el).render(<PopoverHost id={popoverId} />);
} else {
  createRoot(el).render(<App />);
}
