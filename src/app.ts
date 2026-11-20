// Bambu printers on the LAN as a spur: their state
// from one MQTT session each, their cameras, filament, job control and sending a plate. Events for
// what changes; an overview in Switch's catalog and a live camera per printer.
//
// Commands go to real printers only with PRINTERS_COMMANDS=on; PRINTERS_SIM=on runs two simulated
// printers instead, which take every command.
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { Context, Effect, Layer, Schema } from "effect"

import { answer, AppEvents, defineApp, mcpApp, surface, SWITCH_CATALOG, tool } from "spur-kit"
import type { Draft, WidgetDef } from "spur-kit"
import { Camera, tlsEye } from "./camera.ts"
import { COMMANDS, configured, SIM } from "./config.ts"
import type { Printer } from "./config.ts"
import { presetFor } from "./filaments.ts"
import { ftpsCard } from "./files.ts"
import type { Card } from "./files.ts"
import { Link, mqttDial } from "./link.ts"
import { noActivities } from "./live.ts"
import type { LiveActivities, PrintActivity } from "./live.ts"
import { filamentSetting, jobControl, projectFile } from "./payloads.ts"
import { SIM_PRINTERS, simCard, simDial, simEye } from "./sim.ts"
import {
  EVENTS,
  FilamentRanOut,
  JobFailed,
  JobFinished,
  JobProgress,
  JobStarted,
  PrinterError,
  SlotsChanged,
  StateChanged,
} from "./events.ts"
import { isActive, viewOf } from "./state.ts"
import type { Raw, View } from "./state.ts"
import { bambu, makingTools } from "./making.ts"
import { track } from "./track.ts"
import type { Seen } from "./track.ts"
import { lineOf, SWAP } from "./board.ts"
import { cameraHtml } from "./view/build.ts"

const APP = "printers"
/** The space its widgets suggest. */
export const PRINTING = "printing"

const PRINTERS: readonly Printer[] = SIM ? SIM_PRINTERS : configured()

// ── Printers ──

const HMS_DIRS = [
  path.join(homedir(), "Library", "Application Support", "BambuStudio", "hms"),
  "/Applications/BambuStudio.app/Contents/Resources/hms",
]

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x)

const field = (x: unknown, key: string): unknown => (isRecord(x) ? x[key] : undefined)

/** One HMS table's English texts, by code. */
const textsIn = (table: unknown, into: Map<string, string>) => {
  const data = field(table, "data")
  for (const part of [
    field(field(data, "device_error"), "en"),
    field(field(data, "device_hms"), "en"),
  ]) {
    for (const e of Array.isArray(part) ? part : []) {
      const ecode = field(e, "ecode")
      const intro = field(e, "intro")
      if (
        typeof ecode === "string" &&
        typeof intro === "string" &&
        !into.has(ecode.toUpperCase())
      ) {
        into.set(ecode.toUpperCase(), intro)
      }
    }
  }
}

/** Bambu's English texts for error codes, from Bambu Studio's HMS tables; codes alone without. */
const loadTexts = () => {
  const texts = new Map<string, string>()
  for (const dir of HMS_DIRS.filter((d) => existsSync(d))) {
    for (const f of readdirSync(dir).filter((x) => /^hms_en_.+\.json$/u.test(x))) {
      try {
        textsIn(JSON.parse(readFileSync(path.join(dir, f), "utf-8")), texts)
      } catch {
        // A table that won't parse: its codes show bare.
      }
    }
  }
  return texts
}

interface Entry {
  readonly printer: Printer
  readonly link: Link
  readonly camera: Camera
}

const ignore = () => {
  // The iPhone's tool failing must not stop the spur.
}

const activityOf = (v: View): PrintActivity => ({
  printer: v.id,
  name: v.name,
  file: v.file ?? "",
  phase: v.phase,
  percent: v.percent,
  layer: v.layer,
  layers: v.layers,
  endsAt: v.endsAt,
})

export class Printers extends Context.Service<
  Printers,
  {
    readonly entries: readonly Entry[]
    readonly view: (e: Entry) => View
    readonly card: Card
  }
>()("switch/printers/Printers") {
  static readonly layer = (options: { readonly activities?: LiveActivities } = {}) =>
    Layer.effect(
      Printers,
      Effect.gen(function* making() {
        const events = yield* AppEvents
        const activities = options.activities ?? noActivities
        const texts = loadTexts()
        const emit = (draft: Draft) => {
          Effect.runFork(Effect.ignore(events.emit(draft)))
        }

        const entries: Entry[] = PRINTERS.map((printer) => {
          const link = new Link(printer.id, SIM ? simDial : mqttDial, COMMANDS)
          const camera = new Camera(printer.id, SIM ? simEye : tlsEye, () =>
            isActive(typeof link.raw.gcode_state === "string" ? link.raw.gcode_state : ""),
          )
          return { printer, link, camera }
        })
        const view = (e: Entry) => viewOf(e.printer, e.link.raw, e.link.online(), texts, Date.now())

        const seen = new Map<string, Seen>()
        /** What changed since this printer's last report, as events and the print's activity. */
        const step = (e: Entry) => {
          const v = view(e)
          const stage = typeof e.link.raw.stg_cur === "number" ? e.link.raw.stg_cur : undefined
          const out = track(seen.get(v.id), v, stage, Date.now())
          if (out.seen) {
            seen.set(v.id, out.seen)
          }
          for (const d of out.drafts) {
            emit(d)
          }
          if (out.activity) {
            const { kind, key } = out.activity
            activities[kind](key, activityOf(v)).catch(ignore)
          }
        }

        for (const e of entries) {
          e.link.subscribe(() => {
            e.camera.poke()
            step(e)
          })
        }
        // Offline only counts after GONE_MS, which no report marks.
        const ticker = setInterval(() => {
          for (const e of entries) {
            step(e)
          }
        }, 5000)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            clearInterval(ticker)
            for (const e of entries) {
              e.camera.stop()
              e.link.close()
            }
          }),
        )
        return { entries, view, card: SIM ? simCard : ftpsCard }
      }),
    )
}

// ── Tools ──

const attempt = <A>(f: () => Promise<A>) =>
  Effect.tryPromise({
    try: f,
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })

/** A printer by its id or its name, in any case. */
const find = (printers: typeof Printers.Service, name: string) => {
  const wanted = name.trim().toLowerCase()
  const e = printers.entries.find(
    (x) => x.printer.id === wanted || x.printer.name.toLowerCase() === wanted,
  )
  if (!e) {
    const known = printers.entries.map((x) => x.printer.name).join(", ")
    return Effect.fail(new Error(`No printer ${name} (${known || "none set up"})`))
  }
  return Effect.succeed(e)
}

/** Sends, then waits for the printer's reports to show it. */
const sendAndConfirm = async (
  link: Link,
  request: Parameters<Link["send"]>[0],
  confirmed: (raw: Raw) => boolean,
  ms: number,
) => {
  const reply = await link.send(request)
  if (reply && !reply.ok) {
    throw new Error(`Refused${reply.reason === undefined ? "" : `: ${reply.reason}`}`)
  }
  if (await link.waitFor(confirmed, ms)) {
    return
  }
  if (!reply) {
    throw new Error("No answer")
  }
}

const stateOf = (raw: Raw) => (typeof raw.gcode_state === "string" ? raw.gcode_state : "")

const which = Schema.Struct({ printer: Schema.String })

const status = tool(
  "status",
  {
    description:
      "Every printer, or one: state, progress, time left, layer, temperatures, the AMS slots and errors.",
    readOnly: true,
    input: Schema.Struct({ printer: Schema.optionalKey(Schema.String) }),
  },
  (input) =>
    Effect.gen(function* reading() {
      const printers = yield* Printers
      const chosen =
        input.printer === undefined ? printers.entries : [yield* find(printers, input.printer)]
      return { asOf: Date.now(), printers: chosen.map(printers.view) }
    }),
)

const board = tool(
  "board",
  {
    description: "Every printer as its widget draws it.",
    readOnly: true,
  },
  () =>
    Effect.gen(function* drawing() {
      const printers = yield* Printers
      return { printers: printers.entries.map((e) => lineOf(printers.view(e))) }
    }),
)

const control = (action: "pause" | "resume" | "stop", description: string) =>
  tool(action, { description, input: which }, (input) =>
    Effect.gen(function* controlling() {
      const printers = yield* Printers
      const e = yield* find(printers, input.printer)
      const { link } = e
      if (!link.online()) {
        return yield* Effect.fail(new Error(`${e.printer.name} is offline`))
      }
      const state = stateOf(link.raw)
      if (!isActive(state)) {
        return yield* Effect.fail(new Error(`${e.printer.name} isn't printing`))
      }
      if (action === "resume" && state !== "PAUSE") {
        return yield* Effect.fail(new Error(`${e.printer.name} isn't paused`))
      }
      if (action === "pause" && state === "PAUSE") {
        return yield* Effect.fail(new Error(`${e.printer.name} is already paused`))
      }
      const confirmed = {
        pause: (r: Raw) => stateOf(r) === "PAUSE",
        resume: (r: Raw) => stateOf(r) === "RUNNING",
        stop: (r: Raw) => !isActive(stateOf(r)),
      }[action]
      yield* attempt(async () => {
        await sendAndConfirm(link, jobControl(link.nextSeq(), action), confirmed, 15_000)
      })
      return printers.view(e)
    }),
  )

const pause = control("pause", "Pause a printer's job.")
const resume = control("resume", "Resume a paused job.")
const stop = control("stop", "Stop a printer's job. It can't be resumed.")

const setFilament = tool(
  "set_filament",
  {
    description:
      'Set what an AMS slot (A1-A4) or the external spool ("ext") holds: type (PLA, PETG, ASA, ABS, TPU), color (RRGGBB) and brand (Generic when left out; Bambu, Polymaker...). Only tells the printer; it moves no filament.',
    input: Schema.Struct({
      printer: Schema.String,
      slot: Schema.String,
      type: Schema.String,
      color: Schema.String,
      brand: Schema.optionalKey(Schema.String),
    }),
  },
  (input) =>
    Effect.gen(function* setting() {
      const printers = yield* Printers
      const e = yield* find(printers, input.printer)
      const { link } = e
      if (!link.online()) {
        return yield* Effect.fail(new Error(`${e.printer.name} is offline`))
      }
      const color = input.color.replace(/^#/u, "").toUpperCase()
      if (!/^[0-9A-F]{6}$/u.test(color)) {
        return yield* Effect.fail(new Error(`Color ${input.color} isn't RRGGBB`))
      }
      const preset = presetFor(input.type, input.brand)
      if (!preset) {
        return yield* Effect.fail(new Error(`No ${input.brand ?? "Generic"} ${input.type} preset`))
      }
      const v = printers.view(e)
      const slotName = input.slot.trim().toUpperCase()
      const ext = slotName === "EXT" || slotName === "EXTERNAL"
      const slot = v.slots.find((s) => s.slot === slotName)
      if (!ext && !slot) {
        const has = v.slots.map((s) => s.slot).join(", ")
        return yield* Effect.fail(
          new Error(
            `${e.printer.name} has no slot ${input.slot}${has ? ` (${has}, ext)` : " (ext)"}`,
          ),
        )
      }
      if (slot?.rfid === true) {
        return yield* Effect.fail(new Error(`${slotName} holds a Bambu spool; its tag sets it`))
      }
      const where = slot
        ? { ams: Math.floor(slot.tray / 4), tray: slot.tray % 4 }
        : { ams: 255, tray: 254 }
      const shows = (r: Raw) => {
        const after = viewOf(e.printer, r, true, new Map(), Date.now())
        const got = slot ? after.slots.find((s) => s.slot === slotName) : after.spool
        return got?.type === preset.type && got.color === color
      }
      yield* attempt(async () => {
        await sendAndConfirm(
          link,
          filamentSetting(link.nextSeq(), where, preset, color),
          shows,
          8000,
        )
      })
      return printers.view(e)
    }),
)

const files = tool(
  "files",
  {
    description: "The files on a printer's card (plates sent to it, timelapses aside).",
    readOnly: true,
    input: which,
  },
  (input) =>
    Effect.gen(function* listing() {
      const printers = yield* Printers
      const e = yield* find(printers, input.printer)
      const all = yield* attempt(async () => await printers.card.list(e.printer.id))
      return { printer: e.printer.id, files: all.toSorted((a, b) => (b.at ?? 0) - (a.at ?? 0)) }
    }),
)

const camera = tool(
  "camera",
  { description: "A printer's camera, now.", readOnly: true, input: which },
  (input) =>
    Effect.gen(function* looking() {
      const printers = yield* Printers
      const e = yield* find(printers, input.printer)
      const frame = yield* attempt(async () => await e.camera.frame())
      if (!frame) {
        return yield* Effect.fail(new Error(e.camera.problem || "No picture"))
      }
      const data = frame.jpeg.toString("base64")
      return answer(
        { printer: e.printer.id, at: frame.at, source: frame.source, mimeType: "image/jpeg", data },
        [{ type: "image", data, mimeType: "image/jpeg" }],
      )
    }),
)

interface Filament {
  readonly id: number
  readonly type: string
  readonly color: string
}

/** The filaments a plate uses, from its slice_info.config. */
const filamentsOf = (file: string): Filament[] => {
  let info = ""
  try {
    info = execFileSync("unzip", ["-p", file, "Metadata/slice_info.config"], {
      encoding: "utf-8",
      maxBuffer: 16_000_000,
    })
  } catch {
    return []
  }
  return [...info.matchAll(/<filament\b[^>]*>/gu)].flatMap((m) => {
    const [tag] = m
    const id = Number(/\bid="(?<v>\d+)"/u.exec(tag)?.groups?.v)
    const type = /\btype="(?<v>[^"]+)"/u.exec(tag)?.groups?.v
    const color = /\bcolor="#?(?<v>[0-9A-Fa-f]{6})/u.exec(tag)?.groups?.v
    return Number.isFinite(id) && type !== undefined
      ? [{ id, type, color: (color ?? "").toUpperCase() }]
      : []
  })
}

/** Which tray each sliced filament runs from: [] for the external spool, as the CLI plans it. */
const plan = (v: View, filaments: readonly Filament[], picked: readonly string[] | undefined) => {
  if (v.slots.length === 0 || picked?.[0]?.toLowerCase() === "ext") {
    if (filaments.length > 1) {
      throw new Error(`${v.name} has one spool; the plate uses ${filaments.length} filaments`)
    }
    const want = filaments[0]?.type
    if (want !== undefined && v.spool !== undefined && v.spool.type !== want) {
      throw new Error(`${v.name} has ${v.spool.type} loaded; the plate wants ${want}`)
    }
    return []
  }
  const top = Math.max(0, ...filaments.map((f) => f.id))
  const mapping: number[] = Array.from({ length: top }, () => -1)
  for (const [i, f] of filaments.entries()) {
    const name = picked?.[i]?.toUpperCase()
    const slot =
      name === undefined
        ? (v.slots.find((s) => s.type === f.type && s.color === f.color) ??
          v.slots.find((s) => s.type === f.type))
        : v.slots.find((s) => s.slot === name)
    if (slot?.loaded !== true) {
      throw new Error(name === undefined ? `No slot holds ${f.type}` : `${name} is empty`)
    }
    if (slot.type !== f.type) {
      throw new Error(
        `${slot.slot} holds ${slot.type ?? "nothing set"}; filament ${f.id} is ${f.type}`,
      )
    }
    mapping[f.id - 1] = slot.tray
  }
  return mapping
}

/** The CLI's check, upload and start: a big file over weak Wi-Fi takes minutes. */
const CLI_MS = 15 * 60_000

/**
 * A plate through the CLI, as by hand: `bambu check` (it refuses on an error), the AMS plan, the
 * full purge after a spool change, the upload, the start and the timelapse recorder.
 */
const viaCli = async (
  id: string,
  file: string,
  options: {
    readonly slots?: readonly string[]
    readonly level: boolean
    readonly dryRun: boolean
  },
) => {
  const args = ["-p", id, "print", file]
  const { slots } = options
  if (slots !== undefined && slots.length > 1) {
    args.push("--ams-map", slots.join(","))
  } else if (slots?.[0] !== undefined) {
    args.push("--ams", slots[0])
  }
  if (!options.level) {
    args.push("--no-level")
  }
  if (options.dryRun) {
    args.push("--dry-run")
  }
  const said = await bambu(args, CLI_MS)
  return said.slice(-20)
}

const print = tool(
  "print",
  {
    description:
      "Send a sliced plate (.gcode.3mf on this machine) to a printer and start it, through the bambu CLI: its pre-print check, AMS plan, purge after a spool change, upload and timelapse recorder. Only on a cleared bed, and only when the user wants it printed. `slots` picks the AMS slot for each filament in order (A1, A3) or ext; by default each filament takes a slot holding its type. `dryRun` runs the check and the plan and sends nothing.",
    input: Schema.Struct({
      printer: Schema.String,
      file: Schema.String,
      slots: Schema.optionalKey(Schema.Array(Schema.String)),
      /** Bed leveling first: on by default. */
      level: Schema.optionalKey(Schema.Boolean),
      dryRun: Schema.optionalKey(Schema.Boolean),
    }),
  },
  (input) =>
    Effect.gen(function* printing() {
      const printers = yield* Printers
      const e = yield* find(printers, input.printer)
      const { link } = e
      const file = input.file.replace(/^~\//u, `${homedir()}/`)
      const name = path.basename(file)
      const dryRun = input.dryRun ?? false
      if (!name.endsWith(".gcode.3mf") || !existsSync(file)) {
        return yield* Effect.fail(new Error(`No plate at ${input.file}`))
      }
      if (!link.online()) {
        return yield* Effect.fail(new Error(`${e.printer.name} is offline`))
      }
      if (!link.commands && !dryRun) {
        return yield* Effect.fail(new Error("Commands are off"))
      }
      const v = printers.view(e)
      if (isActive(v.state)) {
        return yield* Effect.fail(new Error(`${e.printer.name} is busy`))
      }
      const level = input.level ?? true
      if (!SIM) {
        const said = yield* attempt(
          async () =>
            await viaCli(e.printer.id, file, {
              ...(input.slots === undefined ? {} : { slots: input.slots }),
              level,
              dryRun,
            }),
        )
        if (!dryRun) {
          yield* attempt(async () => await link.waitFor((r) => isActive(stateOf(r)), 60_000))
        }
        return { printer: printers.view(e), said }
      }
      // The simulator has no CLI: the same requests, sent directly.
      const mapping = yield* Effect.try({
        try: () => plan(v, filamentsOf(file), input.slots),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      })
      if (dryRun) {
        return { printer: v, said: [`dry run: ${name} fits ${e.printer.name}; nothing sent`] }
      }
      yield* attempt(async () => {
        const { size } = statSync(file)
        const there = await printers.card.list(e.printer.id)
        if (!there.some((f) => f.name === name && f.size === size)) {
          await printers.card.upload(e.printer.id, file, name)
        }
        const md5 = new Bun.CryptoHasher("md5").update(readFileSync(file)).digest("hex")
        const request = projectFile(link.nextSeq(), { name, md5 }, { mapping, level })
        await sendAndConfirm(link, request, (r) => isActive(stateOf(r)), 60_000)
      })
      return { printer: printers.view(e), said: [] }
    }),
)

const num = (r: Raw, key: string) => (typeof r[key] === "number" ? r[key] : 0)

const GOALS = ["started", "printing", "done", "layer", "percent", "change"] as const

const wait = tool(
  "wait",
  {
    description:
      "Follow a printer until something happens: started (a job is on it), printing (the first layer is going down), done (the job ended), layer or percent (reached `value`), change (its state moved). At most `minutes` (default 30, up to 180); answers how it stands either way.",
    readOnly: true,
    input: Schema.Struct({
      printer: Schema.String,
      until: Schema.Literals(GOALS),
      value: Schema.optionalKey(Schema.Finite),
      minutes: Schema.optionalKey(Schema.Finite),
    }),
  },
  (input) =>
    Effect.gen(function* waiting() {
      const printers = yield* Printers
      const e = yield* find(printers, input.printer)
      const first = stateOf(e.link.raw)
      const want = input.value ?? 0
      const tests: Record<(typeof GOALS)[number], (r: Raw) => boolean> = {
        started: (r) => isActive(stateOf(r)),
        printing: (r) => stateOf(r) === "RUNNING" && num(r, "layer_num") >= 1,
        done: (r) => stateOf(r) !== "" && !isActive(stateOf(r)),
        layer: (r) => num(r, "layer_num") >= want || !isActive(stateOf(r)),
        percent: (r) => num(r, "mc_percent") >= want || !isActive(stateOf(r)),
        change: (r) => stateOf(r) !== first,
      }
      const ms = Math.min(180, Math.max(1, input.minutes ?? 30)) * 60_000
      const reached = yield* attempt(async () => await e.link.waitFor(tests[input.until], ms))
      return { reached, printer: printers.view(e) }
    }),
)

// ── Widgets ──

const overview: WidgetDef = {
  name: "overview",
  title: "Printers",
  surfaces: ["space"],
  resource: "ui://printers/overview",
  space: PRINTING,
  spaceName: "Printing",
  size: { aspect: "wide", min: { cols: 4, rows: 2 }, preferred: { cols: 8, rows: 3 }, grows: true },
  tool: "board",
  refresh: [
    StateChanged.type,
    JobStarted.type,
    JobProgress.type,
    JobFinished.type,
    JobFailed.type,
    FilamentRanOut.type,
    PrinterError.type,
    SlotsChanged.type,
  ],
  // A Row per printer in Switch's catalog, over a Pick per slot that swaps its filament.
  a2ui: () =>
    surface("overview", SWITCH_CATALOG, [
      { id: "root", component: "Lines", children: { componentId: "printer", path: "/printers" } },
      {
        id: "printer",
        component: "Row",
        label: { "@path": "label" },
        mark: { "@path": "mark" },
        detail: { "@path": "detail" },
        alert: { "@path": "alert" },
        values: { "@path": "values" },
        progress: { "@path": "progress" },
        endsAt: { "@path": "endsAt" },
        children: { componentId: "cell", path: "cells" },
      },
      {
        id: "cell",
        component: "Pick",
        label: { "@path": "label" },
        swatch: { "@path": "swatch" },
        strong: { "@path": "strong" },
        title: { "@path": "title" },
        current: { "@path": "current" },
        args: { "@path": "args" },
        groups: SWAP,
        action: "set_filament",
      },
    ]),
}

// Built when the spur starts: Bun runs no macros from an installed package.
const html = cameraHtml()

const cameraWidget = (p: Printer): WidgetDef => ({
  name: `camera-${p.id}`,
  title: p.name,
  surfaces: ["space"],
  resource: `ui://printers/camera-${p.id}`,
  space: PRINTING,
  spaceName: "Printing",
  size: {
    aspect: "wide",
    ratio: 16 / 9,
    min: { cols: 3, rows: 2 },
    preferred: { cols: 6, rows: 3 },
    grows: true,
  },
  a2ui: () =>
    mcpApp("camera", {
      title: p.name,
      html: html.replace("__PRINTER__", p.id).replaceAll("__APP__", APP),
      allowedTools: [`${APP}_camera`, `${APP}_status`],
    }),
})

export const printersApp = defineApp<Printers>({
  name: APP,
  version: "1",
  instructions: [
    "Bambu printers on the LAN, as status lists them (model, external spool, AMS slots A1-A4). Name the printer whenever you report on one.",
    "Designing a part to print: read rules (design) first.",
    "Printing: inspect STLs made elsewhere and pick the bed face; slice; read the summary (time, filament_g, objects, bed_C) and every check WARNING, and say the time; confirm the printer's bed is clear (FINISH means the last part is likely still on it); print (dryRun first to see the plan); wait until printing. Every print records a timelapse (timelapse list).",
    "After a spool swap, set_filament on that slot or the external spool right away: print matches the plate against what the printer reports.",
  ].join("\n"),
  tools: [
    status,
    board,
    camera,
    files,
    setFilament,
    pause,
    resume,
    stop,
    print,
    wait,
    ...makingTools,
  ],
  events: EVENTS,
  widgets: [overview, ...PRINTERS.map(cameraWidget)],
})
