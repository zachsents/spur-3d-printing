// A printer's camera: TLS on port 6000, an 80-byte login, then length-prefixed JPEGs, about one a
// second, as the `bambu` CLI's grab_frame reads it.
//
// The camera serves one client at a time, and a print's timelapse recorder must never miss a frame,
// so: while a recorder on this Mac holds the printer (a live pid in its lock), its newest frame is
// served and the camera is never touched. While a job runs without one here (a recorder may run on
// another Mac), only a quick grab, at most every GRAB_MS. Otherwise one stream is held while someone
// looks, and let go LINGER_MS after they stop, or at once when a print starts.
import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import tls from "node:tls"

import { readConnection } from "./config.ts"
import { cameraLogin } from "./payloads.ts"

const RECORDERS =
  process.env.PRINTERS_RECORDERS ?? path.join(homedir(), ".cache", "bambu", "timelapse")
/** While a job runs, a quick grab at most this often. */
const GRAB_MS = 20_000
/** Keep a live stream this long after the last look. */
const LINGER_MS = 10_000
/** How long a look waits for a first frame. */
const FIRST_MS = 8000
const MAX_FRAME = 4_000_000

export interface Frame {
  readonly jpeg: Buffer
  readonly at: number
  readonly source: "live" | "grab" | "recorder"
}

/** Opens a camera stream: frames as they come, `onEnd` once if it closes by itself. `signal` closes it. */
export type Eye = (
  id: string,
  signal: AbortSignal,
  onFrame: (jpeg: Buffer) => void,
  onEnd: (problem: string) => void,
) => void

const isJpeg = (b: Buffer) =>
  b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b.at(-2) === 0xff && b.at(-1) === 0xd9

/** The real camera, on the LAN. */
export const tlsEye: Eye = (id, signal, onFrame, onEnd) => {
  let ended = false
  const end = (problem: string) => {
    if (!ended) {
      ended = true
      onEnd(problem)
    }
  }
  let conn: ReturnType<typeof readConnection>
  try {
    conn = readConnection(id)
  } catch (error) {
    end(error instanceof Error ? error.message : String(error))
    return
  }
  const socket = tls.connect({ host: conn.host, port: 6000, rejectUnauthorized: false })
  socket.setTimeout(15_000)
  let buf = Buffer.alloc(0)
  socket.on("secureConnect", () => {
    socket.write(cameraLogin(conn.accessCode))
  })
  socket.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk])
    while (buf.length >= 16) {
      const size = buf.readUInt32LE(0)
      if (size > MAX_FRAME) {
        end("Bad camera stream")
        socket.destroy()
        return
      }
      if (buf.length < 16 + size) {
        return
      }
      const jpeg = Buffer.from(buf.subarray(16, 16 + size))
      buf = buf.subarray(16 + size)
      if (!isJpeg(jpeg)) {
        end("Bad camera stream")
        socket.destroy()
        return
      }
      if (!signal.aborted) {
        onFrame(jpeg)
      }
    }
  })
  socket.on("timeout", () => {
    end("Camera timed out")
    socket.destroy()
  })
  socket.on("error", (error) => {
    end(error.message)
  })
  socket.on("close", () => {
    end("Camera closed")
  })
  signal.addEventListener("abort", () => {
    ended = true
    socket.destroy()
  })
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Whether `pid` is a running `bambu timelapse record`. When it can't tell, it counts as one. */
const isRecorder = (pid: number) => {
  try {
    process.kill(pid, 0)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false
    }
  }
  const ps = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf-8" })
  return ps.error === undefined ? ps.stdout.includes("timelapse record") : true
}

/** The newest frame of a recorder holding this printer's camera on this Mac, if one does. */
const recorderFrame = (id: string): Frame | "held" | undefined => {
  const lock = path.join(RECORDERS, `${id}.json`)
  if (!existsSync(lock)) {
    return undefined
  }
  const info = parseJson(readFileSync(lock, "utf-8"))
  if (typeof info !== "object" || info === null || !("pid" in info) || !("frames" in info)) {
    return undefined
  }
  const { pid, frames } = info
  if (typeof pid !== "number" || typeof frames !== "string" || !isRecorder(pid)) {
    return undefined
  }
  const names = existsSync(frames)
    ? readdirSync(frames)
        .filter((n) => /^\d+\.jpg$/u.test(n))
        .toSorted()
    : []
  const newest = names.at(-1)
  if (newest === undefined) {
    return "held"
  }
  const file = path.join(frames, newest)
  return { jpeg: readFileSync(file), at: statSync(file).mtimeMs, source: "recorder" }
}

/** After a stream fails, wait this long before opening another. */
const RETRY_MS = 5000

export class Camera {
  latest: Frame | undefined
  problem = ""
  readonly id: string
  private readonly eye: Eye
  /** A job is on the printer. */
  private readonly busy: () => boolean
  private stream: AbortController | undefined
  private lastAsked = 0
  private retryAt = 0
  private linger: ReturnType<typeof setInterval> | undefined
  private grabbing: Promise<void> | undefined
  private readonly waiting = new Set<() => void>()

  constructor(id: string, eye: Eye, busy: () => boolean) {
    this.id = id
    this.eye = eye
    this.busy = busy
  }

  /** The newest frame for someone looking now, following the rules above. */
  async frame(): Promise<Frame | undefined> {
    this.lastAsked = Date.now()
    const held = recorderFrame(this.id)
    if (held !== undefined) {
      this.letGo()
      if (held !== "held") {
        this.latest = held
      }
      return this.latest
    }
    if (this.busy()) {
      this.letGo()
      if ((!this.latest || Date.now() - this.latest.at > GRAB_MS) && Date.now() >= this.retryAt) {
        await this.grab()
      }
      return this.latest
    }
    if (!this.stream && Date.now() >= this.retryAt) {
      this.openLive()
    }
    if (this.stream && this.latest?.source !== "live") {
      await this.next(FIRST_MS)
    }
    return this.latest
  }

  /** A report came: a print starting frees the camera at once. */
  poke() {
    if (this.stream && this.busy()) {
      this.letGo()
    }
  }

  stop() {
    this.letGo()
  }

  private async next(ms: number) {
    const { promise, resolve } = Promise.withResolvers<undefined>()
    const done = () => {
      clearTimeout(timer)
      this.waiting.delete(done)
      resolve(undefined)
    }
    const timer = setTimeout(done, ms)
    this.waiting.add(done)
    await promise
  }

  private got(jpeg: Buffer, source: Frame["source"]) {
    this.latest = { jpeg, at: Date.now(), source }
    this.problem = ""
    for (const w of this.waiting) {
      w()
    }
  }

  private failed(problem: string) {
    this.problem = problem
    this.retryAt = Date.now() + RETRY_MS
    for (const w of this.waiting) {
      w()
    }
  }

  private async grab() {
    if (this.grabbing === undefined) {
      const { promise, resolve } = Promise.withResolvers<undefined>()
      const stop = new AbortController()
      this.eye(
        this.id,
        stop.signal,
        (jpeg) => {
          this.got(jpeg, "grab")
          stop.abort()
          resolve(undefined)
        },
        (problem) => {
          this.failed(problem)
          resolve(undefined)
        },
      )
      const timer = setTimeout(() => {
        stop.abort()
        resolve(undefined)
      }, FIRST_MS)
      this.grabbing = promise.finally(() => {
        clearTimeout(timer)
        this.grabbing = undefined
      })
    }
    await this.grabbing
  }

  private openLive() {
    const stop = new AbortController()
    this.stream = stop
    this.eye(
      this.id,
      stop.signal,
      (jpeg) => {
        this.got(jpeg, "live")
      },
      (problem) => {
        this.failed(problem)
        if (this.stream === stop) {
          this.letGo()
        }
      },
    )
    if (this.stream !== stop) {
      return
    }
    clearInterval(this.linger)
    this.linger = setInterval(() => {
      if (Date.now() - this.lastAsked > LINGER_MS || this.busy()) {
        this.letGo()
      }
    }, 1000)
  }

  private letGo() {
    clearInterval(this.linger)
    this.linger = undefined
    const s = this.stream
    this.stream = undefined
    s?.abort()
    if (this.latest?.source === "live") {
      this.latest = { ...this.latest, source: "grab" }
    }
  }
}
