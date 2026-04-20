"""Overlay 파일(JSONL) 스키마 검증기.

decisions/schema/*.schema.json 을 기준으로 decisions.jsonl / annotations.jsonl /
feedback.jsonl 및 refactor_targets.json을 검증한다.

사용 예:
    python scripts/validate_overlay.py
    python scripts/validate_overlay.py --file decisions/decisions.jsonl
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

try:
    import jsonschema
except ImportError:
    print("[ERR] jsonschema 패키지 필요. `pip install jsonschema`", file=sys.stderr)
    sys.exit(2)


PKG_ROOT = Path(__file__).resolve().parents[1]
DECISIONS_DIR = PKG_ROOT / "decisions"
SCHEMA_DIR = DECISIONS_DIR / "schema"

TARGETS = [
    (DECISIONS_DIR / "decisions.jsonl", SCHEMA_DIR / "decision.schema.json", "jsonl"),
    (DECISIONS_DIR / "annotations.jsonl", SCHEMA_DIR / "annotation.schema.json", "jsonl"),
    (DECISIONS_DIR / "feedback.jsonl", SCHEMA_DIR / "feedback.schema.json", "jsonl"),
    (DECISIONS_DIR / "refactor_targets.json", SCHEMA_DIR / "refactor_targets.schema.json", "json"),
]


def load_schema(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def validate_jsonl(path: Path, schema: dict) -> list[str]:
    errors: list[str] = []
    if not path.exists():
        return errors
    for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError as e:
            errors.append(f"{path.name}:L{i}: JSON parse: {e}")
            continue
        try:
            jsonschema.validate(obj, schema)
        except jsonschema.ValidationError as e:
            errors.append(f"{path.name}:L{i}: schema: {e.message} @ {list(e.path)}")
    return errors


def validate_json(path: Path, schema: dict) -> list[str]:
    if not path.exists():
        return []
    try:
        obj = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        return [f"{path.name}: JSON parse: {e}"]
    try:
        jsonschema.validate(obj, schema)
    except jsonschema.ValidationError as e:
        return [f"{path.name}: schema: {e.message} @ {list(e.path)}"]
    return []


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Overlay 스키마 검증")
    p.add_argument("--file", type=Path, help="특정 파일만 검증 (생략 시 전체)")
    return p.parse_args()


def main() -> int:
    args = parse_args()

    total_errors: list[str] = []
    checked = 0
    for path, schema_path, kind in TARGETS:
        if args.file and path != args.file.resolve():
            continue
        if not schema_path.exists():
            total_errors.append(f"[SCHEMA MISSING] {schema_path}")
            continue
        schema = load_schema(schema_path)
        errors = validate_jsonl(path, schema) if kind == "jsonl" else validate_json(path, schema)
        if not path.exists():
            print(f"  - {path.name}: (not present, skipped)")
            continue
        checked += 1
        if errors:
            total_errors.extend(errors)
            print(f"  - {path.name}: {len(errors)} error(s)")
        else:
            print(f"  - {path.name}: OK")

    print()
    if total_errors:
        print(f"[FAIL] {len(total_errors)} error(s):")
        for e in total_errors:
            print(f"  {e}")
        return 1
    print(f"[OK] {checked} file(s) validated")
    return 0


if __name__ == "__main__":
    sys.exit(main())
