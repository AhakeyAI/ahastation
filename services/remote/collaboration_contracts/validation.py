"""Read the same repository JSON Schema as Electron; never resolve remote schemas."""
from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from referencing import Registry, Resource

ROOT = Path(__file__).resolve().parents[3]
SCHEMA = json.loads((ROOT / "contracts/collaboration/v1.schema.json").read_text(encoding="utf-8"))
NAMES = (
    "deviceConfig", "device", "projectConfig", "project", "localBinding",
    "bindingReport", "bindingSummary", "authorizationRequest", "authorization",
    "workspaceRequest", "workspace", "event", "localAuthorizationEvent", "snapshot",
)
Draft202012Validator.check_schema(SCHEMA)
REGISTRY = Registry().with_resource(SCHEMA["$id"], Resource.from_contents(SCHEMA))
VALIDATORS = {
    name: Draft202012Validator({"$ref": SCHEMA["$id"] + "#/$defs/" + name}, registry=REGISTRY)
    for name in NAMES
}


def _json_check(value: Any, depth: int = 0, count: list[int] | None = None,
                seen: set[int] | None = None) -> None:
    if count is None:
        count = [0]
    if seen is None:
        seen = set()
    count[0] += 1
    if count[0] > 20000 or depth > 24:
        raise ValueError("JSON complexity limit")
    if value is None or type(value) in (str, bool):
        return
    if type(value) in (int, float):
        if not math.isfinite(value):
            raise ValueError("Non-finite number")
        return
    if type(value) not in (dict, list) or id(value) in seen:
        raise ValueError("Expected acyclic plain JSON")
    seen.add(id(value))
    if type(value) is dict and any(type(key) is not str for key in value):
        raise ValueError("Expected string keys")
    for child in value.values() if type(value) is dict else value:
        _json_check(child, depth + 1, count, seen)
    seen.remove(id(value))


def _unique(values: list[str]) -> bool:
    return len(values) == len(set(values))


def _semantic(name: str, value: dict) -> None:
    if name in ("deviceConfig", "device"):
        if not _unique([agent["agentId"] for agent in value["agents"]]):
            raise ValueError("Duplicate Agent")
    elif name in ("projectConfig", "project"):
        url = value["repository"]["canonicalUrl"]
        if url.endswith(".git") or any(part in (".", "..") for part in url.split("/")[-2:]):
            raise ValueError("Noncanonical repository")
    elif name in ("bindingReport", "bindingSummary"):
        if value["state"] == "ready":
            if value["bindingRevision"] < 1 or "reasonCode" in value:
                raise ValueError("Invalid ready binding")
        elif "reasonCode" not in value:
            raise ValueError("Missing binding reason")
    elif name == "event":
        payload = value["payload"]
        kind = {"device.changed": "device", "project.changed": "project",
                "project.binding_changed": "bindingSummary"}[value["type"]]
        _semantic(kind, payload)
        stream = ("device:" + payload["deviceId"] if kind == "device" else
                  "project:" + payload["projectId"] if kind == "project" else
                  "binding:" + payload["projectId"] + ":" + payload["deviceId"])
        if value["revision"] != payload["revision"] or value["streamId"] != stream:
            raise ValueError("Event identity/revision mismatch")
    elif name == "snapshot":
        for kind, records, keys in (
            ("device", value["devices"], ["deviceId"]),
            ("project", value["projects"], ["projectId"]),
            ("bindingSummary", value["bindings"], ["projectId", "deviceId"]),
        ):
            if not _unique([":".join(record[key] for key in keys) for record in records]):
                raise ValueError("Duplicate entity")
            for record in records:
                _semantic(kind, record)
        devices = {record["deviceId"] for record in value["devices"]}
        projects = {record["projectId"] for record in value["projects"]}
        if any(record["deviceId"] not in devices or record["projectId"] not in projects
               for record in value["bindings"]):
            raise ValueError("Unknown binding reference")


def validate_contract(name: str, value: Any) -> dict:
    """A sanitized Result. Never return jsonschema errors, raw input or local paths."""
    try:
        if name not in VALIDATORS:
            raise ValueError("Unknown contract")
        _json_check(value)
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        if len(encoded.encode("utf-8")) > 262144:
            raise ValueError("JSON byte limit")
        VALIDATORS[name].validate(value)
        _semantic(name, value)
        return {"ok": True, "value": json.loads(encoded)}
    except Exception:
        return {"ok": False, "error": {"code": "INVALID_INPUT",
                "message": "Invalid collaboration contract", "retryable": False}}


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Validate shared fixtures without starting the Hub")
    parser.add_argument("--cases", required=True, type=Path)
    args = parser.parse_args()
    cases = json.loads(args.cases.read_text(encoding="utf-8"))
    print(json.dumps([{"name": case["name"], "ok": validate_contract(case["contract"], case["value"])["ok"]}
                      for case in cases], ensure_ascii=True))
