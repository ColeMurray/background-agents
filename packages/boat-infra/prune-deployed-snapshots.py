#!/usr/bin/env python3
"""Supply confirmed Worker deployment references to Boat base pruning after Terraform deploys."""

from __future__ import annotations

import argparse
import json
import os
import re
import runpy
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path


def replaced_snapshot(get, deployment_id: str, current: tuple[str, str, str, str], prefix: str):
    """Read deployment history, never artifact timestamps, to establish the rollback base."""
    path = "/deployments?per_page=100&page=1"
    first = get(path)
    deployments = first["result"]["deployments"]
    if not deployments or deployments[0]["id"] != deployment_id:
        raise RuntimeError("The expected Worker deployment is not active; nothing was deleted")
    pages = first.get("result_info", {}).get("total_pages")
    if pages is None and len(deployments) >= 100:
        raise RuntimeError("Worker deployment pagination is unknown; nothing was deleted")
    for page in range(2, (pages or 1) + 1):
        if len(deployments) != (page - 1) * 100:
            raise RuntimeError("Worker deployment history is incomplete; nothing was deleted")
        entries = get(f"/deployments?per_page=100&page={page}")["result"]["deployments"]
        if not entries:
            raise RuntimeError("Worker deployment history is incomplete; nothing was deleted")
        deployments += entries
    deployments = sorted(
        deployments, key=lambda entry: datetime.fromisoformat(entry["created_on"]), reverse=True
    )
    times = [datetime.fromisoformat(entry["created_on"]) for entry in deployments]
    ids = [entry["id"] for entry in deployments]
    if ids[0] != deployment_id or len(set(ids)) != len(ids) or len(set(times)) != len(times):
        raise RuntimeError("Worker deployment order is ambiguous; nothing was deleted")

    versions = {}
    previous = None
    for index, deployment in enumerate(deployments):
        serving = deployment["versions"]
        if len(serving) != 1 or serving[0]["percentage"] != 100:
            raise RuntimeError("Cannot prune across a split Worker deployment; nothing was deleted")
        version_id = serving[0]["version_id"]
        if version_id not in versions:
            version = get(f"/versions/{urllib.parse.quote(version_id, safe='')}")["result"]
            if version["id"] != version_id:
                raise RuntimeError("Worker version identity mismatch; nothing was deleted")
            bindings = {
                binding["name"]: binding["text"]
                for binding in version["resources"]["bindings"]
                if binding["type"] == "plain_text"
            }
            provider = bindings["SANDBOX_PROVIDER"]
            versions[version_id] = (
                provider,
                bindings["BOAT_API_URL"].rstrip("/") if provider == "boat" else "",
                bindings.get("BOAT_ORG", "") if provider == "boat" else "",
                bindings["BOAT_BASE_SNAPSHOT"] if provider == "boat" else "",
            )
        reference = versions[version_id]
        if index == 0 and reference != current:
            raise RuntimeError(
                "Active Worker Boat bindings do not match Terraform; nothing was deleted"
            )
        if reference != current:
            # A provider, wallet, or prefix switch leaves the old scope untouched.
            previous = (
                reference[3]
                if reference[:3] == current[:3]
                and re.fullmatch(rf"{re.escape(prefix)}-[0-9a-f]{{16}}", reference[3])
                else ""
            )
            break

    if get(path)["result"]["deployments"][0]["id"] != deployment_id:
        raise RuntimeError("Worker changed while reading history; nothing was deleted")
    # Retained history can be truncated. Exhaustion is not proof of a first deploy.
    return previous


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    builder = runpy.run_path(str(Path(__file__).with_name("build-template.py")))
    prefix = os.environ["BOAT_BASE_SNAPSHOT"]
    builder["validate_base_prefix"](prefix)
    token = os.environ["CLOUDFLARE_API_TOKEN"]
    account = urllib.parse.quote(os.environ["CLOUDFLARE_ACCOUNT_ID"], safe="")
    worker = urllib.parse.quote(os.environ["CLOUDFLARE_WORKER_NAME"], safe="")
    base_url = f"https://api.cloudflare.com/client/v4/accounts/{account}/workers/scripts/{worker}"

    def get(path):
        request = urllib.request.Request(
            f"{base_url}{path}", headers={"Authorization": f"Bearer {token}"}
        )
        try:
            with builder["OPENER"].open(
                request, timeout=builder["REQUEST_TIMEOUT_SECONDS"]
            ) as response:
                envelope = json.loads(response.read())
        except urllib.error.HTTPError as error:
            raise RuntimeError(f"Cloudflare deployment lookup failed: API {error.code}") from None
        if envelope.get("success") is not True:
            raise RuntimeError("Cloudflare deployment lookup failed; nothing was deleted")
        return envelope

    current = (
        "boat",
        (os.environ.get("BOAT_API_URL") or builder["DEFAULT_API_URL"]).rstrip("/"),
        os.environ.get("BOAT_ORG") or "",
        os.environ["BOAT_DEPLOYED_SNAPSHOT"],
    )
    previous = replaced_snapshot(get, os.environ["CLOUDFLARE_DEPLOYMENT_ID"], current, prefix)
    if previous is None:
        print(
            "Worker history does not establish a replaced base; skipping Boat pruning", flush=True
        )
        return
    os.environ["BOAT_REPLACED_SNAPSHOT"] = previous
    builder["main"](["prune", "--dry-run"] if args.dry_run else ["prune"])


if __name__ == "__main__":
    main()
