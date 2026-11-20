// A print in progress as an iPhone Live Activity. iOS draws it from a compiled template, so it's
// not a widget: the iPhone's Live Activity tool starts, updates and ends it. That tool doesn't
// exist yet; this is what the spur hands it, and where the call goes once it does.

/** One print's activity: everything the template shows. */
export interface PrintActivity {
  readonly printer: string
  readonly name: string
  readonly file: string
  readonly phase: string
  readonly percent: number
  readonly layer: number
  readonly layers: number
  /** When it'll be done, in ms. */
  readonly endsAt: number | null
}

/** The iPhone's Live Activity tool, by one key per print. */
export interface LiveActivities {
  readonly start: (key: string, content: PrintActivity) => Promise<void>
  readonly update: (key: string, content: PrintActivity) => Promise<void>
  readonly end: (key: string, content: PrintActivity) => Promise<void>
}

/** Until the iPhone tool exists: nothing is called; the job events carry the same content. */
export const noActivities: LiveActivities = {
  start: async () => {
    await Promise.resolve()
  },
  update: async () => {
    await Promise.resolve()
  },
  end: async () => {
    await Promise.resolve()
  },
}
