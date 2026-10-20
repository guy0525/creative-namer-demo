#!/bin/bash
cd "$(dirname "$0")"
echo "启动创意洞察：http://127.0.0.1:${PORT:-8818}"
exec python3 server.py
