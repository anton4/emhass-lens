#!/bin/sh
docker rm -f el-ha el-mqtt el-emhass >/dev/null 2>&1 || true
docker network rm el-net >/dev/null 2>&1 || true
rm -rf "$(dirname "$0")/.runtime"
echo "stopped"
