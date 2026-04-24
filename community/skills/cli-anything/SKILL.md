---
name: cli-anything
effort: medium
description: "Turn any website into a CLI your agent can call — capture a session once, then use plain HTTP forever. No browser running at runtime. Works for sites with no API or an inadequate one."
triggers: ["cli-anything", "website cli", "no api", "session capture", "plain http adapter", "build a cli for", "cli harness", "create adapter", "opencli record"]
---

# CLI-Anything — Session-Captured HTTP Adapters

> Capture a browser session once. After that, your agent calls the site as a plain CLI command — no browser running, no Playwright, just HTTP.

This pattern is part of the [HKUDS/CLI-Anything](https://github.com/HKUDS/CLI-Anything) framework, which treats websites as structured command-line tools for LLM agents.

---

## When to use this

Use cli-anything when:
- The site has no public API (or the API is locked behind a waitlist)
- The site has an API but it doesn't cover the actions you need (e.g. write operations only available in the UI)
- You need structured JSON output from a site your agent already accesses

Do **not** use this when:
- A supported REST API exists and covers your use case — use it directly
- The site uses heavy client-side rendering that defeats static cookie auth (check first with `curl -b <cookies>`)

---

## How it works

```
Step 1 (once):  Log into the site in Safari or Chrome
Step 2 (once):  Run the session capture script — saves cookies to ~/.claude/credentials/
Step 3 (always): Your agent calls `mysite list-orders --json` → plain HTTP with stored cookies
```

After capture, the adapter runs as pure Python with `urllib` — no browser process, no Playwright dependency at runtime.

---

## Session capture

### Option A: Safari cookies (recommended on macOS)

Log into the target site in Safari, then extract cookies:

```python
#!/usr/bin/env python3
"""Extract cookies from Safari's Cookies.binarycookies for a target domain."""
import json, os, struct, sys

SAFARI_COOKIES = os.path.expanduser("~/Library/Cookies/Cookies.binarycookies")
CREDS_PATH = os.path.expanduser("~/.claude/credentials/mysite-session.json")
TARGET_DOMAIN = "yoursite.com"
APPLE_EPOCH_OFFSET = 978307200.0

def parse_binarycookies(path):
    with open(path, "rb") as f:
        data = f.read()
    if data[:4] != b"cook":
        raise ValueError("Not a Safari BinaryCookies file")
    num_pages = struct.unpack_from(">I", data, 4)[0]
    page_sizes, offset = [], 8
    for _ in range(num_pages):
        page_sizes.append(struct.unpack_from(">I", data, offset)[0])
        offset += 4
    cookies = []
    for size in page_sizes:
        page = data[offset:offset + size]
        offset += size
        if page[:4] != b"\x00\x00\x01\x00":
            continue
        num_cookies = struct.unpack_from("<I", page, 4)[0]
        offsets = [struct.unpack_from("<I", page, 8 + i * 4)[0] for i in range(num_cookies)]
        for co in offsets:
            cookie = _parse_record(page, co)
            if cookie:
                cookies.append(cookie)
    return cookies

def _parse_record(page, co):
    if co + 56 > len(page):
        return None
    size = struct.unpack_from("<I", page, co)[0]
    if size < 56 or co + size > len(page):
        return None
    rec = page[co:co + size]
    def read_str(off):
        if not off or off >= len(rec):
            return ""
        end = rec.index(b"\x00", off)
        return rec[off:end].decode("utf-8", errors="replace")
    domain = read_str(struct.unpack_from("<I", rec, 16)[0])
    name   = read_str(struct.unpack_from("<I", rec, 20)[0])
    path   = read_str(struct.unpack_from("<I", rec, 24)[0])
    value  = read_str(struct.unpack_from("<I", rec, 28)[0])
    expiry = struct.unpack_from("<d", rec, 40)[0] + APPLE_EPOCH_OFFSET
    if not name:
        return None
    return {"name": name, "value": value, "domain": domain, "path": path, "expires": expiry}

if __name__ == "__main__":
    all_cookies = parse_binarycookies(SAFARI_COOKIES)
    site_cookies = [c for c in all_cookies if TARGET_DOMAIN in (c.get("domain") or "")]
    if not site_cookies:
        print(f"No cookies found for {TARGET_DOMAIN}. Log in to the site in Safari first.", file=sys.stderr)
        sys.exit(1)
    os.makedirs(os.path.dirname(CREDS_PATH), exist_ok=True)
    with open(CREDS_PATH, "w") as f:
        json.dump({"cookies": site_cookies}, f, indent=2)
    print(f"Saved {len(site_cookies)} cookies to {CREDS_PATH}")
```

### Option B: API key / OAuth credentials

For sites that use OAuth2 client credentials:

```bash
# Store credentials in agent .env
MYSITE_CLIENT_ID=your-client-id
MYSITE_CLIENT_SECRET=your-client-secret
```

Then fetch a bearer token in `utils.py` using `urllib.request`.

### Option C: Record with opencli (advanced)

If neither Safari cookies nor API keys work, use the opencli skill to record a session:

```bash
opencli record https://yoursite.com/login --site mysite
```

This captures the exact HTTP requests the browser makes, which you can replay as plain HTTP.

---

## Adapter file structure

A minimal working adapter is 3 files:

```
cli_anything/
  mysite/
    __init__.py
    utils.py        # session loading + HTTP helpers
    api_backend.py  # endpoint wrappers returning dicts
    cli.py          # Click commands (the CLI entry point)
setup.py
requirements.txt
```

### `utils.py` — session and HTTP

```python
"""Shared utilities: session loading, plain-HTTP GET, JSON output."""
import json, os, sys, urllib.error, urllib.request, ssl

CREDS_PATH = os.path.expanduser("~/.claude/credentials/mysite-session.json")
BASE_URL = "https://yoursite.com"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"

def load_session() -> dict[str, str]:
    if not os.path.exists(CREDS_PATH):
        print(json.dumps({"error": f"Credentials not found: {CREDS_PATH}"}), file=sys.stderr)
        sys.exit(2)
    with open(CREDS_PATH) as f:
        raw = json.load(f)
    cookies = raw.get("cookies", raw)
    return {c["name"]: c["value"] for c in cookies if c.get("name")}

def _cookie_header() -> str:
    return "; ".join(f"{k}={v}" for k, v in load_session().items())

def api_get(path: str) -> dict:
    req = urllib.request.Request(
        f"{BASE_URL}{path}",
        headers={"Cookie": _cookie_header(), "Accept": "application/json", "User-Agent": UA},
    )
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=15) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        if e.code == 401:
            print(json.dumps({"error": "Session expired — recapture with capture_session.py"}), file=sys.stderr)
            sys.exit(2)
        print(json.dumps({"error": f"HTTP {e.code}"}), file=sys.stderr)
        sys.exit(1)

def output_json(data) -> None:
    print(json.dumps(data, indent=2, default=str))
```

### `api_backend.py` — endpoint wrappers

```python
"""Thin wrappers around site endpoints — one function per resource."""
from .utils import api_get

def probe() -> dict:
    """Verify session and connectivity."""
    try:
        api_get("/api/v1/me")
        return {"ok": True}
    except SystemExit:
        return {"ok": False, "error": "Authentication failed"}

def list_items(status: str = None, limit: int = 25) -> list:
    path = f"/api/v1/items/?limit={limit}"
    if status:
        path += f"&status={status}"
    data = api_get(path)
    return data.get("results", data) if isinstance(data, dict) else data
```

### `cli.py` — Click commands

```python
"""mysite CLI — ms command."""
import click
from . import api_backend
from .utils import output_json

@click.group()
@click.version_option("0.1.0", prog_name="ms")
def cli():
    """Mysite CLI — structured access for AI agents."""
    pass

@cli.command()
def probe():
    """Health check — verify session and connectivity."""
    output_json(api_backend.probe())

@cli.group("items")
def items():
    """Item commands."""
    pass

@items.command("list")
@click.option("--status", default=None, help="Status filter")
@click.option("--limit", default=25, show_default=True)
def list_items(status, limit):
    """List items."""
    output_json(api_backend.list_items(status=status, limit=limit))

if __name__ == "__main__":
    cli()
```

### `setup.py`

```python
from setuptools import find_packages, setup

setup(
    name="cli-anything-mysite",
    version="0.1.0",
    packages=find_packages(),
    install_requires=["click>=8.0"],
    entry_points={"console_scripts": ["ms=cli_anything.mysite.cli:cli"]},
)
```

---

## Install and verify

```bash
cd cli-anything-mysite
pip install -e .
ms probe      # should return {"ok": true}
ms items list --limit 3
```

---

## Session refresh

Sessions expire. When `probe` returns `{"error": "Session expired"}`:

1. Log into the site in Safari
2. Re-run `python3 capture_session.py`
3. Verify with `ms probe`

No code changes needed — only the credentials file is updated.

---

## Security notes

- Store credential files in `~/.claude/credentials/` — never commit them
- Add `*.json` and `.env` to `.gitignore`
- Credentials are read at runtime; rotating them is just replacing the file

---

## Submitting to CLI-Hub

If your adapter works reliably, submit it to the community:

1. Fork [HKUDS/CLI-Anything](https://github.com/HKUDS/CLI-Anything)
2. Add your adapter under `adapters/<site-name>/`
3. Include a `README.md` with: target URL, auth method, commands, and a working `probe` output
4. Open a pull request

This makes your adapter available to the whole cli-anything ecosystem.
