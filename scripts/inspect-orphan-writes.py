#!/usr/bin/env python3
"""
inspect-orphan-writes.py

Audit and optionally recover documents written by the broken CouchDBAdapter
before the ObsidianRestAdapter switchover. Those docs were stamped with
device="nullsafe-mcp-server" and used SHA-256 hex chunk IDs (~64 chars)
that LiveSync cannot resolve, so they never reached the Obsidian vault.

Usage (run on the VPS, in any directory):
    python3 inspect-orphan-writes.py list
        # Print every orphan doc: path, size, ctime
    python3 inspect-orphan-writes.py preview <count>
        # Show first N chars of reconstructed content for first <count> docs
    python3 inspect-orphan-writes.py recover --url <obsidian_url> --key <api_key>
        # PUT every orphan doc through the Obsidian REST API
        # (idempotent — safe to re-run; existing files are overwritten)
    python3 inspect-orphan-writes.py purge
        # Delete all orphan metadata + their chunks from CouchDB
        # (only run after recover succeeds, or if you accept the loss)

Env vars:
    COUCHDB_URL      default http://localhost:5984
    COUCHDB_DB       default obsidian-vault
    COUCHDB_USER     default admin
    COUCHDB_PASSWORD default <prompt>
"""
import argparse
import getpass
import json
import os
import sys
import urllib.parse
import urllib.request
from urllib.error import HTTPError

DEVICE_TAG = "nullsafe-mcp-server"


def couch_request(method: str, path: str, body=None, raw=False):
    url = f"{COUCH_URL}/{COUCH_DB}{path}"
    data = None
    headers = {"Authorization": f"Basic {AUTH}"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read() if raw else json.loads(r.read())
    except HTTPError as e:
        return {"error": e.code, "body": e.read().decode("utf-8", errors="replace")}


def find_orphans(limit=10000):
    """Return all metadata docs written by the broken adapter."""
    body = {
        "selector": {"device": DEVICE_TAG},
        "fields": ["_id", "_rev", "size", "ctime", "children"],
        "limit": limit,
    }
    res = couch_request("POST", "/_find", body)
    return res.get("docs", [])


def reconstruct(doc):
    """Fetch all chunks and concatenate into the original content string."""
    parts = []
    for chunk_id in doc.get("children", []):
        encoded = urllib.parse.quote(chunk_id, safe="")
        chunk = couch_request("GET", f"/{encoded}")
        if "error" in chunk:
            return None, f"missing chunk {chunk_id}"
        parts.append(chunk.get("data", ""))
    return "".join(parts), None


def cmd_list(_args):
    docs = find_orphans()
    print(f"Found {len(docs)} orphan documents.\n")
    for d in docs:
        ctime = d.get("ctime", 0) // 1000
        print(f"  {d['_id']}  ({d.get('size', '?')}b, ctime={ctime})")


def cmd_preview(args):
    docs = find_orphans()
    n = min(args.count, len(docs))
    print(f"Previewing first {n} of {len(docs)} orphan documents.\n")
    for d in docs[:n]:
        content, err = reconstruct(d)
        print("=" * 70)
        print(d["_id"])
        if err:
            print(f"  [reconstruction failed: {err}]")
            continue
        snippet = content[:300].replace("\n", " ")
        print(f"  {snippet}{'...' if len(content) > 300 else ''}")


def put_to_obsidian(path, content, url, key):
    encoded = "/".join(urllib.parse.quote(p, safe="") for p in path.split("/"))
    req = urllib.request.Request(
        f"{url.rstrip('/')}/vault/{encoded}",
        data=content.encode("utf-8"),
        method="PUT",
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "text/markdown",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status
    except HTTPError as e:
        return f"HTTP {e.code}"


def cmd_recover(args):
    docs = find_orphans()
    print(f"Recovering {len(docs)} documents through Obsidian REST API at {args.url}\n")
    ok, failed, missing = 0, 0, 0
    for d in docs:
        content, err = reconstruct(d)
        if err:
            print(f"  SKIP  {d['_id']} ({err})")
            missing += 1
            continue
        status = put_to_obsidian(d["_id"], content, args.url, args.key)
        if isinstance(status, int) and 200 <= status < 300:
            print(f"  OK    {d['_id']} ({status})")
            ok += 1
        else:
            print(f"  FAIL  {d['_id']} ({status})")
            failed += 1
    print(f"\nrecovered: {ok}  failed: {failed}  missing-chunks: {missing}")


def cmd_purge(_args):
    docs = find_orphans()
    confirm = input(f"DELETE {len(docs)} orphan metadata docs + their chunks? (yes/N) ")
    if confirm.strip().lower() != "yes":
        print("aborted.")
        return
    chunk_ids = set()
    for d in docs:
        chunk_ids.update(d.get("children", []))
    print(f"deleting {len(docs)} metadata docs and {len(chunk_ids)} unique chunks...")
    # Bulk delete
    deletions = [{"_id": d["_id"], "_rev": d["_rev"], "_deleted": True} for d in docs]
    # We need _rev for chunks too; fetch them
    for cid in chunk_ids:
        encoded = urllib.parse.quote(cid, safe="")
        c = couch_request("GET", f"/{encoded}")
        if "error" not in c and "_rev" in c:
            deletions.append({"_id": c["_id"], "_rev": c["_rev"], "_deleted": True})
    res = couch_request("POST", "/_bulk_docs", {"docs": deletions})
    if isinstance(res, list):
        ok = sum(1 for r in res if "ok" in r)
        print(f"deleted {ok} of {len(deletions)} docs.")
    else:
        print(f"bulk delete error: {res}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    p_preview = sub.add_parser("preview")
    p_preview.add_argument("count", type=int, default=5, nargs="?")
    p_recover = sub.add_parser("recover")
    p_recover.add_argument("--url", required=True, help="Obsidian REST URL (e.g. https://obsidian.softcrashentity.com)")
    p_recover.add_argument("--key", required=True, help="Bearer API key")
    sub.add_parser("purge")
    args = parser.parse_args()

    global COUCH_URL, COUCH_DB, AUTH
    COUCH_URL = os.environ.get("COUCHDB_URL", "http://localhost:5984")
    COUCH_DB = os.environ.get("COUCHDB_DB", "obsidian-vault")
    user = os.environ.get("COUCHDB_USER", "admin")
    password = os.environ.get("COUCHDB_PASSWORD") or getpass.getpass(f"CouchDB password for {user}: ")
    import base64
    AUTH = base64.b64encode(f"{user}:{password}".encode()).decode()

    {
        "list": cmd_list,
        "preview": cmd_preview,
        "recover": cmd_recover,
        "purge": cmd_purge,
    }[args.cmd](args)


if __name__ == "__main__":
    main()
