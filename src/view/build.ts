// The camera view as one HTML document, its script bundled in: an MCP App view loads nothing from
// outside.
import path from "node:path"
import { view } from "spur-kit"

const STYLE = [
  "html,body{margin:0;height:100%;background:#000;overflow:hidden;font:13px -apple-system,system-ui,sans-serif;color:#fff;-webkit-user-select:none;user-select:none}",
  "img{display:block;width:100%;height:100%;object-fit:cover}",
  "#bar{position:absolute;left:0;right:0;bottom:0;display:flex;align-items:center;gap:10px;height:30px;padding:0 14px;background:linear-gradient(transparent,rgba(0,0,0,.72))}",
  "#name{font-weight:600;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
  ".data{font:11px ui-monospace,'SF Mono',monospace;font-variant-numeric:tabular-nums;color:rgba(255,255,255,.85)}",
  "#none{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,.6)}",
  "#lamp{width:8px;height:8px;border-radius:50%;flex:none}",
].join("")

const BODY =
  '<img id="frame" alt=""><div id="none"></div><div id="bar"><span id="lamp"></span><span id="name"></span><span id="progress" class="data"></span><span id="left" class="data"></span><span id="temps" class="data"></span></div>'

export const cameraHtml = (): string =>
  view(path.join(import.meta.dir, "camera.ts"), { style: STYLE, body: BODY }).replace(
    "<body>",
    '<body data-printer="__PRINTER__" data-app="__APP__">',
  )
