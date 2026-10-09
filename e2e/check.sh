#!/bin/sh
# Run EMHASS Lens against the e2e stack and check the whole chain.
set -eu
cd "$(dirname "$0")/../backend"
uv run python ../e2e/check.py "$@"
