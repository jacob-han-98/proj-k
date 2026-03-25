#!/usr/bin/env python3
"""파이프라인 테스트 데이터 리셋 스크립트.

사용법:
  python reset_pipeline.py                          # 대화형: 무엇을 리셋할지 선택
  python reset_pipeline.py --source 2 --after-stage crawled   # Confluence의 crawled 이후 단계 리셋
  python reset_pipeline.py --source 2 --jobs-only   # 작업(pending/running)만 삭제
  python reset_pipeline.py --all-jobs               # 모든 pending 작업 삭제
  python reset_pipeline.py --dry-run                # 실행 않고 대상만 표시

리셋 동작:
  --after-stage <status>:
    해당 status 이후의 문서를 이전 단계로 되돌리고,
    관련 pending 작업을 삭제하고,
    crawl_sources의 last_crawl_at을 초기화합니다.

  예: --after-stage crawled → downloaded/enriched/converted → crawled로 리셋
"""
import argparse
import json
import sqlite3
import sys
from pathlib import Path

# 상태 진행 순서
STATUS_ORDER = ['new', 'crawled', 'downloaded', 'captured', 'converted', 'enriched', 'indexed']


def get_db_path() -> Path:
    import os
    return Path(os.getenv("PIPELINE_DB_PATH", str(Path.home() / ".data-pipeline" / "pipeline.db")))


def main():
    parser = argparse.ArgumentParser(description="파이프라인 테스트 데이터 리셋")
    parser.add_argument("--source", type=int, help="소스 ID (예: 1=7_System, 2=Confluence)")
    parser.add_argument("--after-stage", type=str, choices=STATUS_ORDER,
                        help="이 단계 이후의 문서를 이 단계로 되돌림")
    parser.add_argument("--reset-crawl-time", action="store_true",
                        help="소스의 last_crawl_at을 초기화 (다음 크롤 시 full crawl)")
    parser.add_argument("--jobs-only", action="store_true",
                        help="pending/running 작업만 삭제 (문서 상태 유지)")
    parser.add_argument("--all-jobs", action="store_true",
                        help="모든 소스의 pending 작업 삭제")
    parser.add_argument("--dry-run", action="store_true",
                        help="실행 않고 대상만 표시")
    args = parser.parse_args()

    db_path = get_db_path()
    if not db_path.exists():
        print(f"DB not found: {db_path}")
        sys.exit(1)

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row

    try:
        # 현재 상태 요약
        print("=== 현재 상태 ===")
        for r in conn.execute("SELECT id, name, source_type, properties FROM crawl_sources"):
            props = json.loads(r['properties'] or '{}')
            lca = props.get('last_crawl_at', '-')
            print(f"  Source {r['id']}: {r['name']} ({r['source_type']}) last_crawl={lca}")

        print()
        for r in conn.execute("SELECT status, count(*) as cnt FROM documents GROUP BY status ORDER BY cnt DESC"):
            print(f"  문서 {r['status']}: {r['cnt']}")

        print()
        for r in conn.execute("SELECT status, count(*) as cnt FROM jobs GROUP BY status ORDER BY cnt DESC"):
            print(f"  작업 {r['status']}: {r['cnt']}")
        print()

        actions = []

        # --all-jobs: 모든 pending 작업 삭제
        if args.all_jobs:
            cnt = conn.execute("SELECT count(*) as cnt FROM jobs WHERE status IN ('pending', 'running')").fetchone()['cnt']
            actions.append(("DELETE FROM jobs WHERE status IN ('pending', 'running')", [], f"pending/running 작업 {cnt}건 삭제"))

        # --source + --jobs-only
        elif args.jobs_only and args.source:
            cnt = conn.execute(
                "SELECT count(*) as cnt FROM jobs WHERE status IN ('pending', 'running') AND source_id = ?",
                [args.source]
            ).fetchone()['cnt']
            actions.append((
                "DELETE FROM jobs WHERE status IN ('pending', 'running') AND source_id = ?",
                [args.source], f"Source {args.source}의 pending/running 작업 {cnt}건 삭제"
            ))

        # --source + --after-stage
        elif args.after_stage and args.source:
            target_idx = STATUS_ORDER.index(args.after_stage)
            later_statuses = STATUS_ORDER[target_idx + 1:]

            if later_statuses:
                placeholders = ','.join('?' * len(later_statuses))
                cnt = conn.execute(
                    f"SELECT count(*) as cnt FROM documents WHERE source_id = ? AND status IN ({placeholders})",
                    [args.source] + later_statuses
                ).fetchone()['cnt']
                actions.append((
                    f"UPDATE documents SET status = ?, updated_at = datetime('now') WHERE source_id = ? AND status IN ({placeholders})",
                    [args.after_stage, args.source] + later_statuses,
                    f"Source {args.source}의 문서 {cnt}건: {later_statuses} → {args.after_stage}"
                ))

            # 관련 pending 작업도 삭제
            cnt2 = conn.execute(
                "SELECT count(*) as cnt FROM jobs WHERE status IN ('pending', 'running') AND source_id = ?",
                [args.source]
            ).fetchone()['cnt']
            if cnt2:
                actions.append((
                    "DELETE FROM jobs WHERE status IN ('pending', 'running') AND source_id = ?",
                    [args.source], f"Source {args.source}의 pending/running 작업 {cnt2}건 삭제"
                ))

        # --reset-crawl-time
        if args.reset_crawl_time and args.source:
            row = conn.execute("SELECT properties FROM crawl_sources WHERE id = ?", [args.source]).fetchone()
            if row:
                props = json.loads(row['properties'] or '{}')
                if 'last_crawl_at' in props:
                    old = props['last_crawl_at']
                    del props['last_crawl_at']
                    actions.append((
                        "UPDATE crawl_sources SET properties = ?, updated_at = datetime('now') WHERE id = ?",
                        [json.dumps(props, ensure_ascii=False), args.source],
                        f"Source {args.source}의 last_crawl_at 제거 (was: {old})"
                    ))

        if not actions:
            print("리셋 대상이 없습니다. --help로 사용법을 확인하세요.")
            sys.exit(0)

        print("=== 리셋 계획 ===")
        for _, _, desc in actions:
            print(f"  → {desc}")

        if args.dry_run:
            print("\n(dry-run: 실행하지 않음)")
            return

        print()
        for sql, params, desc in actions:
            conn.execute(sql, params)
            print(f"  ✓ {desc}")

        conn.commit()
        print("\n리셋 완료!")

        # 리셋 후 상태
        print("\n=== 리셋 후 상태 ===")
        for r in conn.execute("SELECT status, count(*) as cnt FROM documents GROUP BY status ORDER BY cnt DESC"):
            print(f"  문서 {r['status']}: {r['cnt']}")
        for r in conn.execute("SELECT status, count(*) as cnt FROM jobs GROUP BY status ORDER BY cnt DESC"):
            print(f"  작업 {r['status']}: {r['cnt']}")

    finally:
        conn.close()


if __name__ == "__main__":
    main()
