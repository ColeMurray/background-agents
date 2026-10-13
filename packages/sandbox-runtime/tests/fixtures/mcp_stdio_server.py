"""Minimal stdio MCP server for wire tests: advertises the tools named in argv."""

import json
import sys

TOOLS = sys.argv[1:]


def reply(message_id, result):
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": message_id, "result": result}) + "\n")
    sys.stdout.flush()


for line in sys.stdin:
    message = json.loads(line)
    method = message.get("method")
    if "id" not in message:
        continue
    if method == "initialize":
        reply(
            message["id"],
            {
                "protocolVersion": message["params"]["protocolVersion"],
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "wire-test", "version": "1.0.0"},
            },
        )
    elif method == "tools/list":
        reply(
            message["id"],
            {
                "tools": [
                    {
                        "name": name,
                        "description": f"Wire test tool {name}",
                        "inputSchema": {"type": "object", "properties": {}},
                    }
                    for name in TOOLS
                ]
            },
        )
    else:
        reply(message["id"], {})
