"""Uniform local interface for image inputs and provider-native builds."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

from .bundle import PROVIDERS, _inventory_entry, _walk, canonical_json, pack_bundle, plan_image
from .locks import update_locks
from .native import native_operation
from .releases import _write_json, candidate_record, promote, rollback, write_candidate


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command",
        choices=(
            "plan",
            "hash",
            "pack",
            "lock",
            "record",
            "build",
            "verify",
            "promote",
            "rollback",
        ),
    )
    parser.add_argument("--provider", choices=(*PROVIDERS, "all"), default="all")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[4])
    parser.add_argument("--output", type=Path)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--scope")
    parser.add_argument("--reference")
    parser.add_argument("--candidate", type=Path)
    parser.add_argument("--store", type=Path)
    parser.add_argument(
        "--deployment",
        action="store_true",
        help="Include Modal function deployment inputs as well as its image recipe",
    )
    args = parser.parse_args()
    if args.command in ("promote", "rollback"):
        if not args.store:
            parser.error("promotion requires an explicit Git-tracked --store path")
        if args.command == "promote":
            if not args.candidate:
                parser.error("promote requires --candidate")
            promote(args.store, json.loads(args.candidate.read_text()))
        else:
            if args.provider == "all":
                parser.error("rollback requires one provider")
            rollback(args.store, args.provider)
        print(
            "Selection updated locally. Review and commit the release lock, then deploy; no provider artifact was changed."
        )
        return
    if args.command in ("build", "verify"):
        if args.provider == "all":
            parser.error("native operations require one explicit provider")
        candidate = json.loads(args.candidate.read_text()) if args.candidate else None
        if args.command == "verify" and candidate is None:
            parser.error("verify requires --candidate")
        record = native_operation(args.root.resolve(), args.provider, candidate)
        if args.output:
            _write_json(args.output, record)
        else:
            print(json.dumps(record))
        return
    if args.command == "record":
        if args.provider == "all" or not args.scope or not args.reference:
            parser.error("record requires provider, scope, and immutable reference")
        write_candidate(
            candidate_record(args.provider, args.scope, args.reference, json.load(sys.stdin))
        )
        return
    if args.command == "lock":
        update_locks(args.root, check=args.check)
        return
    providers = PROVIDERS if args.provider == "all" else (args.provider,)
    if args.command == "hash":
        if len(providers) != 1:
            parser.error("hash requires one provider")
        plan = plan_image(args.root, args.provider)
        digest = plan["buildDigest"]
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
        print(json.dumps({"hash": digest, "recipe": plan["recipeDigest"]}))
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
