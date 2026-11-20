// The MQTT requests a P1 takes (device/SERIAL/request), as Bambu Studio and the `bambu` CLI send
// them. Each carries its own
// sequence_id, which the printer echoes in its reply.

type Field = string | number | boolean | readonly unknown[]

export interface Request {
  readonly section: "print" | "system" | "pushing"
  readonly body: { readonly sequence_id: string; readonly command: string } & Readonly<
    Record<string, Field>
  >
}

export const encode = ({ section, body }: Request) => JSON.stringify({ [section]: body })

/** Asks for a full report; a P1 otherwise pushes only what changed. Reads, changes nothing. */
export const pushall = (seq: string): Request => ({
  section: "pushing",
  body: { sequence_id: seq, command: "pushall" },
})

export const jobControl = (seq: string, action: "pause" | "resume" | "stop"): Request => ({
  section: "print",
  body: { sequence_id: seq, command: action },
})

export interface Preset {
  /** Bambu Studio's filament id (tray_info_idx): GFL99 for Generic PLA. */
  readonly idx: string
  readonly type: string
  readonly minTemp: number
  readonly maxTemp: number
}

/**
 * What the printer thinks is in an AMS slot (ams 0.., tray 0..3) or on the external spool (ams
 * 255, tray 254), as `bambu spool` sets it. `color` is RRGGBB; the printer wants RRGGBBAA.
 */
export const filamentSetting = (
  seq: string,
  where: { readonly ams: number; readonly tray: number },
  preset: Preset,
  color: string,
): Request => {
  const hex = color.replace(/^#/u, "").toUpperCase()
  return {
    section: "print",
    body: {
      sequence_id: seq,
      command: "ams_filament_setting",
      ams_id: where.ams,
      tray_id: where.tray,
      tray_info_idx: preset.idx,
      tray_type: preset.type,
      tray_color: hex.length === 8 ? hex : `${hex}FF`,
      nozzle_temp_min: preset.minTemp,
      nozzle_temp_max: preset.maxTemp,
    },
  }
}

/**
 * Starts plate 1 of /name on the card, as the CLI's project_file_payload. `mapping` is, per sliced
 * filament, the global tray it runs from (-1 unused); empty prints from the external spool.
 */
export const projectFile = (
  seq: string,
  file: { readonly name: string; readonly md5: string },
  options: { readonly mapping: readonly number[]; readonly level: boolean },
): Request => {
  const useAms = options.mapping.length > 0
  return {
    section: "print",
    body: {
      sequence_id: seq,
      command: "project_file",
      param: "Metadata/plate_1.gcode",
      url: `ftp:///${file.name}`,
      md5: file.md5,
      subtask_name: file.name.replace(/\.gcode\.3mf$/u, ""),
      project_id: "0",
      profile_id: "0",
      task_id: "0",
      subtask_id: "0",
      timelapse: false,
      bed_type: "auto",
      bed_leveling: options.level,
      bed_levelling: options.level,
      flow_cali: false,
      vibration_cali: false,
      layer_inspect: false,
      use_ams: useAms,
      ams_mapping: options.mapping,
      ...(useAms
        ? {
            ams_mapping2: options.mapping.map((t) =>
              t >= 0
                ? { ams_id: Math.floor(t / 4), slot_id: t % 4 }
                : { ams_id: 255, slot_id: 255 },
            ),
          }
        : {}),
    },
  }
}

/**
 * The camera's 80-byte login (TLS on port 6000), like the CLI's grab_frame: four little-endian
 * words (0x40, 0x3000, 0, 0), then the user and the access code, each padded to 32 bytes.
 */
export const cameraLogin = (accessCode: string) => {
  const login = Buffer.alloc(80)
  login.writeUInt32LE(0x40, 0)
  login.writeUInt32LE(0x30_00, 4)
  login.write("bblp", 16, "utf-8")
  login.write(accessCode, 48, 32, "utf-8")
  return login
}
