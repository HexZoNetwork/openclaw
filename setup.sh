#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

EXAMPLE_CONFIG="$ROOT_DIR/examples/telegram-party.example.jsonc"
LOCAL_ENV="$ROOT_DIR/.env"
LOCAL_CONFIG_COPY="$ROOT_DIR/telegram-party.local.jsonc"
OPENCLAW_HOME_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
OPENCLAW_CONFIG_FILE="${OPENCLAW_CONFIG_PATH:-$OPENCLAW_HOME_DIR/openclaw.json}"
OPENCLAW_EXAMPLE_COPY="$OPENCLAW_HOME_DIR/openclaw.party.example.jsonc"

say() {
  printf '%s\n' "$*"
}

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    say "Missing required command: $1"
    exit 1
  fi
}

need_cmd node
need_cmd pnpm

NODE_VERSION_RAW="$(node -p 'process.versions.node' 2>/dev/null || true)"
NODE_MAJOR="${NODE_VERSION_RAW%%.*}"
if [[ -z "$NODE_MAJOR" || "$NODE_MAJOR" -lt 22 ]]; then
  say "Node 22+ is required. Current version: ${NODE_VERSION_RAW:-unknown}"
  exit 1
fi

say "Installing workspace dependencies..."
pnpm install

if [[ -f "$ROOT_DIR/.env.example" && ! -f "$LOCAL_ENV" ]]; then
  cp "$ROOT_DIR/.env.example" "$LOCAL_ENV"
  say "Created .env from .env.example"
else
  say "Kept existing .env"
fi

mkdir -p "$OPENCLAW_HOME_DIR"

if [[ -f "$EXAMPLE_CONFIG" ]]; then
  cp "$EXAMPLE_CONFIG" "$LOCAL_CONFIG_COPY"
  cp "$EXAMPLE_CONFIG" "$OPENCLAW_EXAMPLE_COPY"
  say "Wrote example configs:"
  say "  - $LOCAL_CONFIG_COPY"
  say "  - $OPENCLAW_EXAMPLE_COPY"
fi

if [[ ! -f "$OPENCLAW_CONFIG_FILE" ]]; then
  cp "$EXAMPLE_CONFIG" "$OPENCLAW_CONFIG_FILE"
  say "Created $OPENCLAW_CONFIG_FILE"
else
  say "Kept existing $OPENCLAW_CONFIG_FILE"
  say "Example party config is available at $OPENCLAW_EXAMPLE_COPY"
fi

say ""
say "Next steps:"
say "1. Fill API keys in $LOCAL_ENV"
say "2. Replace Telegram bot tokens and group ID in $OPENCLAW_CONFIG_FILE"
say "3. Add more bot accounts under channels.telegram.accounts"
say "4. Add the same account IDs to groups.<groupId>.party.participants"
say "5. Run: pnpm openclaw gateway run"
