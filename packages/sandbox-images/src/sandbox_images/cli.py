"""Uniform local interface for image inputs and provider-native builds."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from .bundle import PROVIDERS, _inventory_entry, _walk, canonical_json, pack_bundle, plan_image
from .locks import update_locks
from .native import native_operation


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command",
        choices=(
            "plan",
            "hash",
            "pack",
            "lock",
            "build",
            "verify",
        ),
    )
    parser.add_argument("--provider", choices=(*PROVIDERS, "all"), default="all")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[4])
    parser.add_argument("--output", type=Path)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--reference")
    parser.add_argument(
        "--deployment",
        action="store_true",
        help="Include Modal function deployment inputs as well as its image recipe",
    )
    args = parser.parse_args()
    if args.command in ("build", "verify"):
        if args.provider == "all":
            parser.error("native operations require one explicit provider")
        if args.command == "verify" and not args.reference:
            parser.error("verify requires --reference")
        if args.command == "build" and args.reference is not None:
            parser.error("--reference is only for verify")
        result = native_operation(args.root.resolve(), args.provider, args.reference)
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(result) + "\n")
        else:
            print(json.dumps(result))
        return
    if args.command == "lock":
        update_locks(args.root, check=args.check)
        return
    providers = PROVIDERS if args.provider == "all" else (args.provider,)
    if args.command == "hash":
        if len(providers) != 1:
            parser.error("hash requires one provider")
        plan = plan_image(args.root, args.provider)
        digest = plan["buildHash"]
        if args.deployment:
            if args.provider != "modal":
                parser.error("--deployment is only for Modal functions")
            inventory = [
                _inventory_entry(args.root, path)
                for path in _walk(args.root / "packages/modal-infra/src")
            ]
            digest = hashlib.sha256(
                canonical_json({"recipe": digest, "functions": inventory}).encode()
            ).hexdigest()
        print(json.dumps({"hash": digest, "image": plan["inputHash"]}))
        return
    if args.command == "pack":
        if len(providers) != 1:
            parser.error("pack requires one provider")
        print(
            pack_bundle(
                args.root, args.provider, args.output or args.root / ".cache/sandbox-images"
            )
        )
        return
    print(json.dumps([plan_image(args.root, provider) for provider in providers], indent=2))
