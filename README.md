# spur-3d-printing

Bambu Lab printers on the LAN: live state over MQTT, cameras, AMS filament, job control, and the whole print: slice, plate, check, send, wait, timelapse, with printing and design rules (src/rules.md). Widgets: an overview of every printer and its slots, and a live camera per printer.

A [Switch](https://switch.ax) spur, built on [spur-kit](https://github.com/zachsents/spur-kit).

## Install

Ask Switch's agent to install `github:zachsents/spur-3d-printing`, or add it in the desktop's Spurs view
(⌘K, Spurs). Switch runs it on the first machine with what it needs.

## Setup

- One `<id>.env` per printer in `~/.config/bambu` (or `$PRINTERS_CONFIG`): `BAMBU_HOST`,
  `BAMBU_SERIAL`, `BAMBU_ACCESS_CODE`, and `NAME` for what to call it.
- The `bambu` CLI on `PATH` (or `$PRINTERS_BAMBU`) for slicing and sending.
- Commands reach real printers only with `PRINTERS_COMMANDS=on`; `PRINTERS_SIM=on` runs two
  simulated printers instead.
- The machine running it must provide `lan:printers` (`provides` in `~/.switch/config.json`).

## Develop

```sh
bun install
bun run check
bun start   # serves MCP on stdio
```

## iPhone

`ios/` is Printing for iPhone (SwiftUI, XcodeGen). It reaches this spur through Switch's core, calling the
same tools an agent does. `sh ios/build.sh` installs it on a paired iPhone; `--simulator` builds it
for the simulator. Team, bundle id prefix and the core's address come from the environment or a
`deploy.local` (`ios_team`, `ios_bundle_prefix`, `ios_core`), never the source.
