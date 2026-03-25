#!/usr/bin/env python3
"""
ingest_game_data.py — 게임 데이터시트 SQLite 인제스트 CLI

사용법:
  # 전체 인제스트
  python ingest_game_data.py --design-dir /mnt/d/projectk/resource/design

  # 단일 파일 PoC
  python ingest_game_data.py --file /mnt/d/projectk/resource/design/Skill.xlsx

  # 드라이런 (분석만, DB 미생성)
  python ingest_game_data.py --design-dir /mnt/d/projectk/resource/design --dry-run

  # 커스텀 DB 경로
  python ingest_game_data.py --design-dir ... --db-path ./test_game_data.db
"""

import argparse
import json
import logging
import sys
import time
from pathlib import Path

# 프로젝트 루트 추가
sys.path.insert(0, str(Path(__file__).resolve().parent))

from src.game_data import (
    ingest_all,
    parse_xlsx_table,
    parse_enums,
    load_table_attribute,
    execute_game_query,
    format_game_data_result,
    get_schema_summary,
    is_db_ready,
    DEFAULT_DB_PATH,
    SKIP_SHEETS,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("ingest_cli")


def cmd_ingest(args):
    """전체 또는 단일 파일 인제스트."""
    design_dir = args.design_dir
    db_path = args.db_path or DEFAULT_DB_PATH

    if args.file:
        # 단일 파일 PoC
        file_path = Path(args.file)
        log.info(f"단일 파일 PoC: {file_path.name}")

        import openpyxl
        wb = openpyxl.load_workbook(str(file_path), read_only=True)
        sheets = [s for s in wb.sheetnames if s not in SKIP_SHEETS]
        wb.close()

        for sheet in sheets:
            table = parse_xlsx_table(file_path, sheet)
            if not table:
                continue
            print(f"\n{'='*60}")
            print(f"시트: {sheet} ({len(table.rows)}행, {len(table.columns)}열)")
            print(f"{'='*60}")
            for col in table.columns:
                enum_str = f" [{col.enum_name}]" if col.is_enum else ""
                array_str = " (array)" if col.is_array else ""
                domain_str = f" domain={col.domain}" if col.domain else ""
                print(f"  {col.name:30s} {col.sql_type:10s}{enum_str}{array_str}{domain_str}")
            if table.rows:
                print(f"\n  샘플 데이터 (첫 3행):")
                for i, row in enumerate(table.rows[:3]):
                    vals = [str(v)[:25] if v is not None else "NULL" for v in row[:8]]
                    print(f"    [{i+1}] {' | '.join(vals)}")
        return

    if not design_dir:
        log.error("--design-dir 또는 --file 필요")
        sys.exit(1)

    log.info(f"인제스트 시작: {design_dir}")
    log.info(f"DB 경로: {db_path}")
    log.info(f"드라이런: {args.dry_run}")

    report = ingest_all(design_dir, db_path, dry_run=args.dry_run)

    print(f"\n{'='*60}")
    print(f"인제스트 {'분석' if args.dry_run else '완료'} 리포트")
    print(f"{'='*60}")
    for k, v in report.items():
        if k == "tables" and isinstance(v, list):
            print(f"\n테이블 목록 ({len(v)}개):")
            for t in v:
                print(f"  {t['name']:40s} {t['rows']:>6d}행  {t['columns']:>3d}열  ({t['file']})")
        elif k == "unregistered_sheets" and v:
            print(f"\n등록 외 시트: {', '.join(v)}")
        else:
            print(f"  {k}: {v}")

    if not args.dry_run:
        print(f"\n스키마 요약 (Planning LLM용):")
        print("-" * 60)
        summary = get_schema_summary(db_path)
        # 처음 50줄만 표시
        lines = summary.split("\n")
        for line in lines[:50]:
            print(line)
        if len(lines) > 50:
            print(f"... 외 {len(lines)-50}줄")


def cmd_query(args):
    """인터랙티브 쿼리 테스트."""
    db_path = args.db_path or DEFAULT_DB_PATH
    if not is_db_ready(db_path):
        log.error(f"DB가 없거나 비어 있습니다: {db_path}")
        sys.exit(1)

    if args.action == "list":
        result = execute_game_query({"action": "list_tables"}, db_path)
    elif args.action == "describe":
        result = execute_game_query({"action": "describe", "table": args.table}, db_path)
    elif args.action == "enum":
        result = execute_game_query({"action": "lookup_enum", "enum_type": args.table}, db_path)
    elif args.action == "select":
        spec = {"action": "query", "table": args.table, "limit": args.limit}
        if args.where:
            # 간단한 파서: "Type=Boss" → {"column": "Type", "op": "=", "value": "Boss"}
            filters = []
            for w in args.where:
                for op in [">=", "<=", "!=", "=", ">", "<", " LIKE "]:
                    if op in w:
                        col, val = w.split(op, 1)
                        filters.append({"column": col.strip(), "op": op.strip(), "value": val.strip()})
                        break
            spec["filters"] = filters
        if args.columns:
            spec["columns"] = args.columns.split(",")
        result = execute_game_query(spec, db_path)
    else:
        log.error(f"알 수 없는 action: {args.action}")
        return

    print(format_game_data_result(result))
    print(f"\nSQL: {result.sql}")


def cmd_schema(args):
    """스키마 요약 출력."""
    db_path = args.db_path or DEFAULT_DB_PATH
    if not is_db_ready(db_path):
        log.error(f"DB가 없습니다: {db_path}")
        sys.exit(1)
    print(get_schema_summary(db_path))


def main():
    parser = argparse.ArgumentParser(description="게임 데이터시트 SQLite 인제스트")
    parser.add_argument("--db-path", help="SQLite DB 경로")
    sub = parser.add_subparsers(dest="command")

    # ingest 명령
    p_ingest = sub.add_parser("ingest", help="데이터시트 인제스트")
    p_ingest.add_argument("--design-dir", help="데이터시트 디렉토리")
    p_ingest.add_argument("--file", help="단일 파일 PoC")
    p_ingest.add_argument("--dry-run", action="store_true", help="분석만 (DB 미생성)")

    # query 명령
    p_query = sub.add_parser("query", help="쿼리 테스트")
    p_query.add_argument("action", choices=["list", "describe", "enum", "select"])
    p_query.add_argument("--table", "-t", help="테이블명")
    p_query.add_argument("--where", "-w", nargs="*", help="필터 (예: Type=Boss Level>=50)")
    p_query.add_argument("--columns", "-c", help="컬럼 (쉼표 구분)")
    p_query.add_argument("--limit", "-l", type=int, default=50)

    # schema 명령
    p_schema = sub.add_parser("schema", help="스키마 요약 출력")

    args = parser.parse_args()

    if args.command == "ingest":
        cmd_ingest(args)
    elif args.command == "query":
        cmd_query(args)
    elif args.command == "schema":
        cmd_schema(args)
    else:
        # 기본: --design-dir이나 --file이 있으면 인제스트
        # 없으면 도움말 표시
        parser.print_help()


if __name__ == "__main__":
    main()
