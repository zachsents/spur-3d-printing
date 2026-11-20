/// <reference lib="dom" />

// One printer's live camera, its status along the bottom. Runs as an MCP App view and asks the
// host for frames through the spur's own tools; it speaks the MCP Apps messages itself, as the
// watch face does.
const PROTOCOL = "2026-01-26"
const FRAME_MS = 1000
const STATUS_MS = 5000

const printer = document.body.dataset.printer ?? ""
const app = document.body.dataset.app ?? "printers"
const byId = (id: string) => document.querySelector<HTMLElement>(`#${id}`)
const found = document.querySelector("#frame")
const img = found instanceof HTMLImageElement ? found : null
const none = byId("none")

let next = 2
const pending = new Map<number, (result: unknown, error: unknown) => void>()

const post = (message: Record<string, unknown>) => {
  window.parent.postMessage({ jsonrpc: "2.0", ...message }, "*")
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x)

const request = async (method: string, params: Record<string, unknown>) => {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>()
  const id = next
  next += 1
  pending.set(id, (result, error) => {
    if (error === undefined) {
      resolve(result)
    } else {
      reject(
        new Error(isRecord(error) && typeof error.message === "string" ? error.message : "Failed"),
      )
    }
  })
  post({ id, method, params })
  return await promise
}

/** A tool's structured result, or its words as the error. */
const callTool = async (name: string): Promise<Record<string, unknown>> => {
  const result = await request("tools/call", { name: `${app}_${name}`, arguments: { printer } })
  if (!isRecord(result)) {
    throw new Error("Failed")
  }
  if (result.isError === true) {
    const content = Array.isArray(result.content) ? result.content.filter(isRecord) : []
    const words = content.find((c) => typeof c.text === "string")?.text
    throw new Error(typeof words === "string" ? words : "Failed")
  }
  return isRecord(result.structuredContent) ? result.structuredContent : {}
}

const ignore = () => {
  // Each loop catches its own.
}

const words = (x: unknown) => (typeof x === "string" || typeof x === "number" ? String(x) : "")

const say = (text: string) => {
  if (none) {
    none.textContent = text
  }
}

const left = (endsAt: number | null) => {
  if (endsAt === null) {
    return ""
  }
  const m = Math.max(0, Math.round((endsAt - Date.now()) / 60_000))
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`
}

const LAMPS: Record<string, string> = {
  printing: "background:#f26419;border-radius:50%",
  preparing: "background:#f26419;border-radius:50%",
  paused: "background:#ffc000;border-radius:1px;transform:rotate(45deg)",
  failed:
    "background:#d42a1f;clip-path:polygon(30% 0,70% 0,100% 30%,100% 70%,70% 100%,30% 100%,0 70%,0 30%)",
  offline:
    "background:#d42a1f;clip-path:polygon(30% 0,70% 0,100% 30%,100% 70%,70% 100%,30% 100%,0 70%,0 30%)",
}

let endsAt: number | null = null

const showStatus = (v: Record<string, unknown>) => {
  const phase = words(v.phase)
  const active = phase === "printing" || phase === "preparing" || phase === "paused"
  const lamp = byId("lamp")
  if (lamp) {
    lamp.style.cssText = LAMPS[phase] ?? "display:none"
  }
  const name = byId("name")
  if (name) {
    name.textContent = words(v.name)
  }
  const progress = byId("progress")
  if (progress) {
    progress.textContent = active ? `${words(v.percent)}%` : ""
  }
  endsAt = active && typeof v.endsAt === "number" ? v.endsAt : null
  const temps = byId("temps")
  if (temps) {
    temps.textContent = `${words(v.nozzle)}° ${words(v.bed)}°`
  }
}

const showLeft = () => {
  const l = byId("left")
  if (l) {
    l.textContent = left(endsAt)
  }
}

/** Status every STATUS_MS, one call after another. */
const statusLoop = async () => {
  try {
    const s = await callTool("status")
    const [v] = Array.isArray(s.printers) ? s.printers.filter(isRecord) : []
    if (v) {
      showStatus(v)
    }
  } catch {
    // The frame loop says what's wrong.
  }
  showLeft()
  setTimeout(() => {
    statusLoop().catch(ignore)
  }, STATUS_MS)
}

/** A frame every FRAME_MS, one call after another. */
const frameLoop = async () => {
  try {
    const f = await callTool("camera")
    if (img && typeof f.data === "string") {
      img.src = `data:image/jpeg;base64,${f.data}`
      say("")
      size()
    }
  } catch (error) {
    img?.removeAttribute("src")
    say(error instanceof Error ? error.message : "No picture")
  }
  setTimeout(() => {
    frameLoop().catch(ignore)
  }, FRAME_MS)
}

/** 16:9, the camera's own shape. */
let asked = 0
const size = () => {
  const width = document.documentElement.clientWidth || window.innerWidth
  const height = Math.round((width * 9) / 16)
  if (width > 0 && height !== asked) {
    asked = height
    post({ method: "ui/notifications/size-changed", params: { height } })
  }
}

window.addEventListener(
  "message",
  (e: MessageEvent<{ id?: unknown; result?: unknown; error?: unknown }>) => {
    if (e.source !== window.parent || typeof e.data.id !== "number") {
      return
    }
    if (e.data.id === 1 && e.data.result !== undefined) {
      post({ method: "ui/notifications/initialized" })
      size()
      statusLoop().catch(ignore)
      frameLoop().catch(ignore)
      return
    }
    const done = pending.get(e.data.id)
    if (done) {
      pending.delete(e.data.id)
      done(e.data.result, e.data.error)
    }
  },
)
window.addEventListener("resize", size)

post({
  id: 1,
  method: "ui/initialize",
  params: {
    appInfo: { name: "printers-camera", version: "1" },
    appCapabilities: {},
    protocolVersion: PROTOCOL,
  },
})
