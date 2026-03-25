#!/usr/bin/env python3
"""
Confluence output 디렉토리 정리 스크립트.

문제: 초기 다운로드(run.py)가 flat하게 저장한 페이지가 루트에 잔존.
      이후 data-pipeline download 워커가 올바른 tree_path 기반 경로에 재다운로드.
      결과적으로 루트에 구 버전이, 올바른 위치에 신 버전이 공존.

작업:
1. 중복 (루트 + 올바른 위치 둘 다 존재): 루트의 구 버전 삭제
2. 고아 (DB 미등록, 특수문자로 폴더명 잘림): 올바른 위치로 이동
3. 검증: 루트에 최상위 카테고리만 남았는지 확인

사용법:
    python scripts/fix_confluence_tree.py --dry-run   # 변경 계획 확인
    python scripts/fix_confluence_tree.py              # 실제 실행
"""

import json
import os
import re
import shutil
import sqlite3
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_DIR = PROJECT_ROOT / "packages" / "confluence-downloader" / "output"
DB_PATH = Path.home() / ".data-pipeline" / "pipeline.db"

DRY_RUN = "--dry-run" in sys.argv


def get_db_data():
    """DB에서 Confluence 문서의 title → tree_path 매핑."""
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT title, file_path, metadata FROM documents WHERE source_id=2"
    ).fetchall()
    conn.close()

    title_to_tp = {}
    top_categories = set()
    for r in rows:
        meta = json.loads(r["metadata"] or "{}")
        tp = meta.get("tree_path", r["title"])
        title_to_tp[r["title"]] = tp
        top_categories.add(tp.split("/")[0])

    return title_to_tp, top_categories


def safe_dirname(name: str) -> str:
    """파일시스템 안전한 디렉토리명 (슬래시 등 특수문자 치환)."""
    return re.sub(r'[<>:"|?*]', '_', name)[:100]


def find_orphan_match(dirname: str, title_to_tp: dict) -> tuple:
    """잘린 폴더명(슬래시로 인해)에 매칭되는 DB 항목 찾기."""
    for title, tp in title_to_tp.items():
        # 제목에 '/'가 있어서 폴더명이 잘린 경우
        safe_title = safe_dirname(title)
        if safe_title.startswith(dirname) and len(safe_title) > len(dirname):
            return title, tp
    return None, None


def main():
    print(f"{'[DRY-RUN] ' if DRY_RUN else ''}Confluence output 디렉토리 정리")
    print(f"출력 경로: {OUTPUT_DIR}")
    print()

    title_to_tp, top_cats = get_db_data()
    print(f"DB 문서: {len(title_to_tp)}개")
    print(f"최상위 카테고리: {sorted(top_cats)}")
    print()

    root_dirs = sorted(
        d for d in os.listdir(OUTPUT_DIR)
        if os.path.isdir(OUTPUT_DIR / d) and not d.startswith("_")
    )

    actions = []  # (action, src, dst, reason)

    for d in root_dirs:
        tp = title_to_tp.get(d)

        if tp is None:
            # 고아: DB에 없음 — 폴더명 잘림 확인
            title, matched_tp = find_orphan_match(d, title_to_tp)
            if matched_tp:
                correct_parts = [safe_dirname(p) for p in matched_tp.split("/")]
                correct_path = OUTPUT_DIR / os.sep.join(correct_parts)
                if correct_path.exists():
                    actions.append(("DELETE", OUTPUT_DIR / d, None,
                                    f"고아+중복: DB 제목 '{title}', 올바른 위치에 이미 존재"))
                else:
                    actions.append(("MOVE", OUTPUT_DIR / d, correct_path,
                                    f"고아: DB 제목 '{title}' → {matched_tp}"))
            else:
                actions.append(("WARN", OUTPUT_DIR / d, None,
                                "DB 미등록 + 매칭 실패 — 수동 확인 필요"))
            continue

        if "/" not in tp:
            # 최상위 카테고리 — 루트에 있는 게 맞음
            continue

        # 하위 페이지인데 루트에 있음
        correct_parts = [safe_dirname(p) for p in tp.split("/")]
        correct_path = OUTPUT_DIR / os.sep.join(correct_parts)

        if correct_path.exists():
            actions.append(("DELETE", OUTPUT_DIR / d, None,
                            f"중복: 올바른 위치({tp})에 이미 존재"))
        else:
            actions.append(("MOVE", OUTPUT_DIR / d, correct_path,
                            f"이동: {d} → {tp}"))

    # 실행
    print(f"=== 작업 계획: {len(actions)}건 ===")
    delete_count = 0
    move_count = 0
    warn_count = 0

    for action, src, dst, reason in actions:
        if action == "DELETE":
            print(f"  DELETE {src.name}/  — {reason}")
            if not DRY_RUN:
                shutil.rmtree(src)
            delete_count += 1
        elif action == "MOVE":
            print(f"  MOVE   {src.name}/ → {dst.relative_to(OUTPUT_DIR)}/  — {reason}")
            if not DRY_RUN:
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(src), str(dst))
            move_count += 1
        elif action == "WARN":
            print(f"  WARN   {src.name}/  — {reason}")
            warn_count += 1

    print()
    print(f"결과: 삭제 {delete_count}, 이동 {move_count}, 경고 {warn_count}")

    # 검증
    print()
    print("=== 검증 ===")
    remaining = sorted(
        d for d in os.listdir(OUTPUT_DIR)
        if os.path.isdir(OUTPUT_DIR / d) and not d.startswith("_")
    )
    unexpected = [d for d in remaining if d not in top_cats]
    print(f"루트 디렉토리: {len(remaining)}개")
    if unexpected:
        print(f"  예상 외: {unexpected}")
    else:
        print(f"  모두 최상위 카테고리에 해당 — OK")


if __name__ == "__main__":
    main()
