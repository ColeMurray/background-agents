"""Tiny local MCP peer that reports whether inherited configuration leaked."""

import json
import os
import sys

for line in sys.stdin:
    frame = json.loads(line)
    if "id" not in frame:
        continue
    method = frame.get("method")
    if method == "initialize":
        result = {
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "fixture", "version": "1"},
        }
    elif method == "tools/list":
        result = {
            "tools": [
                {
                    "name": "ready",
                    "description": "Check fixture readiness",
                    "inputSchema": {"type": "object", "properties": {}},
                }
            ]
        }
    elif method == "tools/call":
        result = {
            "content": [
                {
                    "type": "text",
                    "text": "credential present"
                    if (
                        os.environ.get("FIXTURE_MCP_SECRET")
                        or os.environ.get("SESSION_CONFIG")
                        or any(key.startswith("OI_MCP_") for key in os.environ)
                    )
                    else "credential missing",
                }
            ]
        }
    else:
        result = {}
    print(json.dumps({"jsonrpc": "2.0", "id": frame["id"], "result": result}), flush=True)
