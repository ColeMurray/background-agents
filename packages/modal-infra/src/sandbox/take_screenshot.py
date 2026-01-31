#!/usr/bin/env python3
"""
Capture a screenshot of a URL using Playwright (Chromium).
Usage: python take_screenshot.py <url> <output_path> [--full-page]
"""

import argparse
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description="Capture screenshot with Playwright")
    parser.add_argument("url", help="URL to capture (e.g. http://localhost:5173)")
    parser.add_argument("output", help="Output PNG path")
    parser.add_argument("--full-page", action="store_true", help="Capture full scrollable page")
    parser.add_argument("--viewport-width", type=int, default=1280)
    parser.add_argument("--viewport-height", type=int, default=720)
    args = parser.parse_args()

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("playwright not installed", file=sys.stderr)
        return 1

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            context = browser.new_context(
                viewport={"width": args.viewport_width, "height": args.viewport_height}
            )
            page = context.new_page()
            # Use "load" instead of "networkidle" - many pages never reach networkidle
            # (analytics, WebSockets) and would timeout
            page.goto(args.url, wait_until="load", timeout=30000)
            page.screenshot(path=args.output, full_page=args.full_page)
            context.close()
        finally:
            browser.close()

    return 0


if __name__ == "__main__":
    sys.exit(main())
