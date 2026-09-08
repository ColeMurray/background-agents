"""Local commands for shared sandbox dependency installation."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from .bundle import PROVIDERS, pack_bundle, plan_image
from .locks import update_locks
from .native import build_image


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("plan", "hash", "pack", "lock", "build"))
    parser.add_argument("--provider", choices=(*PROVIDERS, "all"), default="all")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[4])
    parser.add_argument("--output", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.command == "lock":
        update_locks(args.root, check=args.check)
        return
    if args.command == "plan":
        providers = PROVIDERS if args.provider == "all" else (args.provider,)
        print(json.dumps([plan_image(args.root, provider) for provider in providers], indent=2))
        return
    if args.provider == "all":
        parser.error(f"{args.command} requires one provider")
    if args.command == "hash":
        print(json.dumps({"hash": plan_image(args.root, args.provider)["buildHash"]}))
    elif args.command == "pack":
        print(
            pack_bundle(
                args.root, args.provider, args.output or args.root / ".cache/sandbox-images"
            )
        )
    else:
        result = build_image(args.root.resolve(), args.provider)
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(result) + "\n")
        else:
            print(json.dumps(result))
