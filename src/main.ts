// The printers spur as a stdio MCP server. Printers come from ~/.config/bambu (or $PRINTERS_CONFIG);
// PRINTERS_SIM=on runs simulated ones instead.
import { serveStdio } from "spur-kit"

import { Printers, printersApp } from "./app.ts"

await serveStdio(printersApp, Printers.layer())
