#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
export NODE_ENV=${NODE_ENV:-production}
export WEB_CONCURRENCY=${WEB_CONCURRENCY:-2}

if [ -f dist/main.js ]; then
  node dist/main.js
elif [ -f dist/src/main.js ]; then
  node dist/src/main.js
else
  echo "Could not find a compiled Nest entry point. Build output is missing." >&2
  exit 1
fi
