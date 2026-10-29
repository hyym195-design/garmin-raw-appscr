"""Local MCP stdio bridge. Credentials are read from the environment, never logged."""
import json
import os
import sys
import urllib.request
import urllib.error
from urllib.parse import urlparse

TOOLS = [
    {"name": "garmin_status", "description": "Show archive coverage, errors and last successful sync. Incomplete backfill is not complete history.", "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}},
    {"name": "garmin_sync", "description": "Continue resumable Garmin import and refresh since last sync, including a three-day overlap. Returns progress; repeat if incomplete.", "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}},
    {"name": "garmin_list", "description": "List archived raw responses overlapping an inclusive date range. By default request incremental refresh first. Inspect freshness and pagination.", "inputSchema": {"type": "object", "properties": {"dataset": {"type": "string"}, "start": {"type": "string"}, "end": {"type": "string"}, "key": {"type": "string"}, "offset": {"type": "integer", "minimum": 0}, "limit": {"type": "integer", "minimum": 1, "maximum": 100}, "sync": {"type": "boolean", "default": True}}, "required": ["dataset"], "additionalProperties": False}},
    {"name": "garmin_get", "description": "Read original Garmin JSON plus fetch metadata. Range responses are whole source files and can include dates outside the filter. Inspect lastSync, historyComplete, lastError and nextOffset. No medical diagnosis.", "inputSchema": {"type": "object", "properties": {"dataset": {"type": "string"}, "start": {"type": "string"}, "end": {"type": "string"}, "key": {"type": "string"}, "offset": {"type": "integer", "minimum": 0}, "limit": {"type": "integer", "minimum": 1, "maximum": 10}, "sync": {"type": "boolean", "default": True}}, "required": ["dataset"], "additionalProperties": False}},
]


def call_api(action, params):
    endpoint = os.environ.get("GARMIN_ARCHIVE_URL", "")
    access_key = os.environ.get("GARMIN_ARCHIVE_ACCESS_KEY", "")
    parsed = urlparse(endpoint)
    if parsed.scheme != "https" or parsed.hostname != "script.google.com" or not parsed.path.endswith("/exec"):
        raise ValueError("Configure GARMIN_ARCHIVE_URL with the deployed Apps Script /exec URL")
    if len(access_key) < 32:
        raise ValueError("Configure GARMIN_ARCHIVE_ACCESS_KEY")
    body = json.dumps({"accessKey": access_key, "action": action, "params": params}).encode()
    req = urllib.request.Request(endpoint, data=body, headers={"Content-Type": "application/json"}, method="POST")
    # urllib follows Google's ContentService redirect to the resulting JSON URL.
    with urllib.request.urlopen(req, timeout=90) as response:
        raw = response.read(4 * 1024 * 1024)
    try:
        return json.loads(raw)
    except (ValueError, UnicodeError):
        raise ValueError("Expected JSON; check web-app deployment access. Google sign-in HTML is not archive data.") from None


def handle(msg):
    method = msg.get("method")
    if method == "initialize":
        version = msg.get("params", {}).get("protocolVersion", "2025-03-26")
        if version not in ("2024-11-05", "2025-03-26", "2025-06-18"):
            version = "2025-03-26"
        return {"protocolVersion": version, "capabilities": {"tools": {}}, "serverInfo": {"name": "garmin-raw-archive", "version": "1.0.0"}}
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": TOOLS}
    if method == "tools/call":
        params = msg.get("params", {})
        actions = {"garmin_status": "status", "garmin_sync": "sync", "garmin_list": "list", "garmin_get": "get"}
        if params.get("name") not in actions:
            raise ValueError("Unknown tool")
        try:
            result = call_api(actions[params["name"]], params.get("arguments", {}))
            return {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}], "isError": not result.get("ok", False)}
        except Exception:
            return {"content": [{"type": "text", "text": "Archive request failed. Check endpoint, access key, deployment access and sync status. Credentials are not included in errors."}], "isError": True}
    raise ValueError("Unknown method")


def main():
    for line in sys.stdin:
        try:
            msg = json.loads(line)
            if "id" not in msg:  # No response to notifications.
                continue
            result = handle(msg)
            answer = {"jsonrpc": "2.0", "id": msg["id"], "result": result}
        except Exception:
            answer = {"jsonrpc": "2.0", "id": msg.get("id") if isinstance(locals().get("msg"), dict) else None, "error": {"code": -32600, "message": "Invalid MCP request"}}
        sys.stdout.write(json.dumps(answer, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
