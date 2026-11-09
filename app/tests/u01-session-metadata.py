"""2026-11-09. U01 selected-session metadata probe. Never read message bodies."""
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3
import tomllib

parser = argparse.ArgumentParser()
parser.add_argument("--root", required=True)
parser.add_argument("--session-id", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
root = Path(args.root).resolve(strict=True)
session_id = args.session_id
if len(session_id) != 36 or any(char not in "0123456789abcdef-" for char in session_id):
    parser.error("session-id must be a UUID")
result = {"date": "2026-11-09", "root": str(root), "sessionId": session_id,
          "sourceTrust": "declared", "authorization": "user selected current chat and data root",
          "records": [], "errors": []}
config_file = root / "config.toml"
sqlite_root = root
try:
    with config_file.open("rb") as handle:
        config = tomllib.load(handle)
    if config.get("sqlite_home"):
        sqlite_root = Path(config["sqlite_home"]).expanduser().resolve()
        if not sqlite_root.is_relative_to(root):
            raise ValueError("sqlite_home is outside the user-selected data root")
except (OSError, ValueError) as error:
    result["errors"].append({"source": "config-location", "error": str(error)})
    sqlite_root = root

for directory in (root / "sessions", root / "archived_sessions"):
    if not directory.exists():
        continue
    for file in directory.rglob(f"*{session_id}*.jsonl"):
        try:
            with file.open("rb") as handle:
                line = handle.readline(1024 * 1024)
            if not line.endswith(b"\n"):
                raise ValueError("metadata record incomplete or exceeds limit")
            record = json.loads(line)
            if record.get("type") != "session_meta" or record.get("payload", {}).get("id") != session_id:
                raise ValueError("metadata type or identity mismatch")
            payload = record["payload"]
            allowed = ("id", "timestamp", "cwd", "originator", "cli_version", "source", "model_provider", "forked_from_id")
            result["records"].append({"kind": "session_meta", "locator": str(file),
                "firstRecordSha256": hashlib.sha256(line).hexdigest(),
                "metadata": {key: payload[key] for key in allowed if key in payload}})
        except (OSError, ValueError) as error:
            result["errors"].append({"source": str(file), "error": str(error)})

index = root / "session_index.jsonl"
if index.exists():
    with index.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            try:
                value = json.loads(line)
            except ValueError:
                continue
            if value.get("id") == session_id:
                result["records"].append({"kind": "index", "locator": f"{index}:{line_number}",
                    "metadata": {key: value[key] for key in ("id", "thread_name", "updated_at") if key in value}})

for database in sqlite_root.glob("state_*.sqlite"):
    try:
        connection = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=2)
        try:
            connection.execute("PRAGMA query_only=ON")
            connection.execute("BEGIN")
            columns = {row[1] for row in connection.execute("PRAGMA table_info(threads)")}
            selected = [column for column in ("id", "title", "cwd", "rollout_path", "source", "cli_version", "model_provider", "archived") if column in columns]
            if "id" not in selected:
                raise ValueError("threads.id unavailable")
            row = connection.execute(f"SELECT {','.join(selected)} FROM threads WHERE id = ?", (session_id,)).fetchone()
            if row:
                result["records"].append({"kind": "sqlite", "locator": str(database), "metadata": dict(zip(selected, row))})
        finally:
            connection.close()
    except (OSError, sqlite3.Error, ValueError) as error:
        result["errors"].append({"source": str(database), "error": str(error)})

Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"records": len(result["records"]), "errors": result["errors"], "output": args.output}, ensure_ascii=False))
