"""Deterministic JSONL peer: no network, credentials or model inference."""

import json
import os
import sys


def send(frame):
    print(json.dumps(frame), flush=True)


for line in sys.stdin:
    frame = json.loads(line)
    method = frame.get("method")
    if method == "initialize":
        send({"id": frame["id"], "result": {"userAgent": "fixture/0.163.0"}})
    elif method == "callbacks":
        send({"id": "slow", "method": "item/tool/call", "params": {}})
        send({"id": 71, "method": "account/chatgptAuthTokens/refresh", "params": {}})
        send({"id": frame["id"], "result": {}})
    elif method == "exit":
        sys.exit(0)
    elif method == "malformed":
        print("not JSON", flush=True)
    elif method == "wait":
        pass
    elif method == "fragmented":
        data = (
            json.dumps(
                {"id": frame["id"], "result": {"text": "hello 🌊"}}, ensure_ascii=False
            ).encode()
            + b"\n"
        )
        for byte in data:
            os.write(1, bytes([byte]))
    elif method == "oversize":
        print("x" * (8 * 1024 * 1024 + 1), flush=True)
    elif method is not None and "id" in frame:
        send({"id": frame["id"], "result": {"echo": method}})
    elif "id" in frame:
        send({"method": "reply/observed", "params": frame})
