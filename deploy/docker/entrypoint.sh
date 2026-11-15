#!/usr/bin/env bash
set -euo pipefail

cd /app
exec bun src/cli.ts serve
