#!/bin/sh
# Start the board daemon (HTTP + WS + overlay on :7890).
cd "$(dirname "$0")/.." && exec npx tsx src/daemon/server.ts
