"""
cli.py - 데이터 파이프라인 CLI

사용법:
    python -m src.cli sources list              # 소스 목록
    python -m src.cli sources sync              # YAML → DB 동기화
    python -m src.cli docs list [--source-id N] # 문서 목록
    python -m src.cli docs status               # 문서 상태 요약
    python -m src.cli jobs list [--status S]    # 작업 목록
    python -m src.cli jobs stats                # 작업 통계
    python -m src.cli issues list               # 이슈 목록
    python -m src.cli pipeline trigger N        # 소스 N 전체 파이프라인
    python -m src.cli pipeline status           # 전체 현황
    python -m src.cli rollback doc N --version V  # 문서 N을 버전 V로 롤백
    python -m src.cli rollback index N          # 인덱스 스냅샷 N으로 롤백
"""

import argparse
import json
import sys
from pathlib import Path

import yaml

PACKAGE_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(PACKAGE_DIR))

from src.db import (
    get_conn, init_db, add_source, list_sources, get_source,
    list_documents, get_document, update_document_status,
    list_jobs, get_job_stats,
    list_issues, create_issue,
    list_conversion_history, rollback_conversion,
    activate_snapshot, get_active_snapshot,
    get_pipeline_stats,
)
from src.worker import trigger_job, trigger_full_pipeline


def cmd_sources_list(args):
    with get_conn() as conn:
        sources = list_sources(conn, enabled_only=not args.all)
    if not sources:
        print("등록된 소스 없음. 'sources sync'로 YAML 반영하세요.")
        return
    print(f"{'ID':>4} {'이름':<25} {'타입':<12} {'전략':<15} {'스케줄':<8} {'경로'}")
    print("-" * 90)
    for s in sources:
        print(f"{s['id']:>4} {s['name']:<25} {s['source_type']:<12} "
              f"{s['convert_strategy']:<15} {s['schedule']:<8} {s['path']}")


def cmd_sources_sync(args):
    config_path = PACKAGE_DIR / "config" / "sources.yaml"
    if not config_path.exists():
        print(f"ERROR: {config_path} 없음")
        return

    with open(config_path, "r", encoding="utf-8") as f:
        config = yaml.safe_load(f)

    sources = config.get("sources", [])
    print(f"YAML에서 {len(sources)}개 소스 로드")

    with get_conn() as conn:
        existing = {s["name"]: s for s in list_sources(conn, enabled_only=False)}

        for src in sources:
            name = src["name"]
            if name in existing:
                print(f"  [SKIP] {name} (이미 등록됨, id={existing[name]['id']})")
                continue

            source_id = add_source(
                conn, name,
                source_type=src["type"],
                path=src["path"],
                convert_strategy=src.get("convert_strategy", "vision-first"),
                properties=src.get("properties", {}),
                schedule=src.get("schedule", "manual"),
            )
            print(f"  [ADD] {name} (id={source_id})")

    print("완료.")


def cmd_docs_list(args):
    with get_conn() as conn:
        docs = list_documents(conn, source_id=args.source_id, status=args.status)
    if not docs:
        print("문서 없음.")
        return
    print(f"{'ID':>5} {'상태':<10} {'타입':<6} {'제목':<35} {'경로'}")
    print("-" * 100)
    for d in docs[:args.limit]:
        title = (d["title"] or "")[:33]
        print(f"{d['id']:>5} {d['status']:<10} {d['file_type']:<6} {title:<35} {d['file_path']}")
    if len(docs) > args.limit:
        print(f"... 외 {len(docs) - args.limit}건")


def cmd_docs_status(args):
    with get_conn() as conn:
        stats = get_pipeline_stats(conn)

    doc_stats = stats["documents"]
    print(f"문서 총 {doc_stats['total']}건")
    for status, cnt in doc_stats.get("by_status", {}).items():
        bar = "█" * min(cnt, 50)
        print(f"  {status:<12} {cnt:>4} {bar}")


def cmd_jobs_list(args):
    with get_conn() as conn:
        jobs = list_jobs(conn, status=args.status, job_type=args.type, limit=args.limit)
    if not jobs:
        print("작업 없음.")
        return
    print(f"{'ID':>5} {'타입':<10} {'상태':<12} {'워커':<15} {'생성일'}")
    print("-" * 70)
    for j in jobs:
        worker = (j["worker_id"] or "-")[:13]
        print(f"{j['id']:>5} {j['job_type']:<10} {j['status']:<12} {worker:<15} {j['created_at']}")


def cmd_jobs_stats(args):
    with get_conn() as conn:
        stats = get_job_stats(conn)
    if not stats:
        print("작업 이력 없음.")
        return
    print("작업큐 상태:")
    for status, cnt in stats.items():
        print(f"  {status:<12} {cnt}")


def cmd_issues_list(args):
    with get_conn() as conn:
        issues = list_issues(conn, status=args.status)
    if not issues:
        print("이슈 없음.")
        return
    print(f"{'ID':>4} {'심각도':<8} {'타입':<14} {'상태':<10} {'제목':<35} {'문서'}")
    print("-" * 100)
    for i in issues:
        title = (i["title"] or "")[:33]
        doc = (i.get("doc_title") or "-")[:20]
        print(f"{i['id']:>4} {i['severity']:<8} {i['issue_type']:<14} "
              f"{i['status']:<10} {title:<35} {doc}")


def cmd_pipeline_trigger(args):
    trigger_full_pipeline(args.source_id)
    print(f"소스 {args.source_id}에 대해 파이프라인 트리거됨.")


def cmd_pipeline_status(args):
    with get_conn() as conn:
        stats = get_pipeline_stats(conn)

    print("=" * 50)
    print("데이터 파이프라인 현황")
    print("=" * 50)
    print(f"소스: {stats['sources']}개")
    print(f"문서: {stats['documents']['total']}개")
    for status, cnt in stats['documents'].get('by_status', {}).items():
        print(f"  {status}: {cnt}")
    print(f"작업큐: {stats['jobs']}")
    print(f"이슈: {stats['issues']}")
    snap = stats.get("active_snapshot")
    if snap:
        print(f"활성 인덱스: {snap['snapshot_name']} ({snap['chunk_count']} 청크)")
    print("=" * 50)


def cmd_rollback_doc(args):
    with get_conn() as conn:
        history = list_conversion_history(conn, args.document_id)
        if not history:
            print(f"문서 {args.document_id}의 변환 이력 없음")
            return

        if args.version:
            rollback_conversion(conn, args.document_id, args.stage or "synthesize", args.version)
            print(f"문서 {args.document_id}를 버전 {args.version}으로 롤백 완료")
        else:
            print(f"문서 {args.document_id} 변환 이력:")
            for c in history:
                active = " [ACTIVE]" if c["is_active"] else ""
                print(f"  v{c['version']} {c['stage']:<12} {c['status']:<10} "
                      f"{c['created_at']}{active}")


def cmd_rollback_index(args):
    with get_conn() as conn:
        activate_snapshot(conn, args.snapshot_id)
        print(f"인덱스 스냅샷 {args.snapshot_id} 활성화 완료")


# ── 메인 ─────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="데이터 파이프라인 CLI")
    sub = parser.add_subparsers(dest="command")

    # sources
    src_parser = sub.add_parser("sources", help="크롤링 소스 관리")
    src_sub = src_parser.add_subparsers(dest="action")
    src_list = src_sub.add_parser("list")
    src_list.add_argument("--all", action="store_true")
    src_sub.add_parser("sync")

    # docs
    doc_parser = sub.add_parser("docs", help="문서 관리")
    doc_sub = doc_parser.add_subparsers(dest="action")
    doc_list = doc_sub.add_parser("list")
    doc_list.add_argument("--source-id", type=int)
    doc_list.add_argument("--status", type=str)
    doc_list.add_argument("--limit", type=int, default=50)
    doc_sub.add_parser("status")

    # jobs
    job_parser = sub.add_parser("jobs", help="작업큐 관리")
    job_sub = job_parser.add_subparsers(dest="action")
    job_list = job_sub.add_parser("list")
    job_list.add_argument("--status", type=str)
    job_list.add_argument("--type", type=str)
    job_list.add_argument("--limit", type=int, default=50)
    job_sub.add_parser("stats")

    # issues
    iss_parser = sub.add_parser("issues", help="품질 이슈 관리")
    iss_sub = iss_parser.add_subparsers(dest="action")
    iss_list = iss_sub.add_parser("list")
    iss_list.add_argument("--status", type=str)

    # pipeline
    pipe_parser = sub.add_parser("pipeline", help="파이프라인 관리")
    pipe_sub = pipe_parser.add_subparsers(dest="action")
    pipe_trigger = pipe_sub.add_parser("trigger")
    pipe_trigger.add_argument("source_id", type=int)
    pipe_sub.add_parser("status")

    # rollback
    rb_parser = sub.add_parser("rollback", help="롤백")
    rb_sub = rb_parser.add_subparsers(dest="action")
    rb_doc = rb_sub.add_parser("doc")
    rb_doc.add_argument("document_id", type=int)
    rb_doc.add_argument("--version", type=int)
    rb_doc.add_argument("--stage", type=str)
    rb_idx = rb_sub.add_parser("index")
    rb_idx.add_argument("snapshot_id", type=int)

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return

    init_db()

    dispatch = {
        ("sources", "list"): cmd_sources_list,
        ("sources", "sync"): cmd_sources_sync,
        ("docs", "list"): cmd_docs_list,
        ("docs", "status"): cmd_docs_status,
        ("jobs", "list"): cmd_jobs_list,
        ("jobs", "stats"): cmd_jobs_stats,
        ("issues", "list"): cmd_issues_list,
        ("pipeline", "trigger"): cmd_pipeline_trigger,
        ("pipeline", "status"): cmd_pipeline_status,
        ("rollback", "doc"): cmd_rollback_doc,
        ("rollback", "index"): cmd_rollback_index,
    }

    handler = dispatch.get((args.command, args.action))
    if handler:
        handler(args)
    else:
        print(f"알 수 없는 명령: {args.command} {args.action}")


if __name__ == "__main__":
    main()
