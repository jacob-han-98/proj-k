"""
import_existing.py - 기존 변환 결과를 파이프라인 DB에 등록

xlsx-extractor/output, confluence-downloader/output의 기존 데이터를
documents + conversions 테이블에 초기 등록한다.

사용법:
    python -m src.import_existing
    python -m src.import_existing --dry-run
"""

import argparse
import hashlib
import json
import sys
from pathlib import Path

PACKAGE_DIR = Path(__file__).parent.parent
PROJECT_ROOT = PACKAGE_DIR.parent.parent
sys.path.insert(0, str(PACKAGE_DIR))

from src.db import (
    get_conn, init_db, add_source, list_sources,
    upsert_document, create_conversion, complete_conversion,
    update_document_status, now_iso
)


def import_xlsx_extractor(dry_run: bool = False):
    """xlsx-extractor/output → documents + conversions."""
    output_dir = PROJECT_ROOT / "packages" / "xlsx-extractor" / "output"
    if not output_dir.exists():
        print(f"  SKIP: {output_dir} 없음")
        return 0

    with get_conn() as conn:
        # 소스 확인/생성
        sources = {s["name"]: s for s in list_sources(conn, enabled_only=False)}
        if "7_System 기획서" not in sources:
            source_id = add_source(conn, "7_System 기획서", "perforce",
                                   "//main/ProjectK/.../7_System/...",
                                   convert_strategy="vision-first",
                                   properties={"local_path": "D:/ProjectK/Design/7_System"})
        else:
            source_id = sources["7_System 기획서"]["id"]

        count = 0
        # 각 워크북 디렉토리 순회
        for wb_dir in sorted(output_dir.iterdir()):
            if not wb_dir.is_dir() or wb_dir.name.startswith("_"):
                continue

            # content.md 파일들 찾기
            content_files = list(wb_dir.rglob("content.md"))
            if not content_files:
                continue

            wb_name = wb_dir.name
            file_path = f"{wb_name}.xlsx"

            if dry_run:
                print(f"  [DRY] {wb_name}: {len(content_files)} sheets")
                count += 1
                continue

            # 문서 등록
            total_size = sum(f.stat().st_size for f in content_files)
            doc_id = upsert_document(
                conn, source_id, file_path, "xlsx",
                file_size=total_size, title=wb_name,
                metadata={"sheet_count": len(content_files), "output_dir": str(wb_dir)}
            )

            # 변환 이력 등록 (현재 결과를 v1으로)
            conv_id = create_conversion(conn, doc_id, "synthesize", "vision-first",
                                        input_path=file_path, version=1)
            complete_conversion(conn, conv_id, str(wb_dir),
                                quality_score=1.0,
                                stats={"sheets": len(content_files), "total_size": total_size})

            update_document_status(conn, doc_id, "converted")
            count += 1
            print(f"  [OK] {wb_name} ({len(content_files)} sheets, {total_size//1024}KB)")

    return count


def import_confluence_downloader(dry_run: bool = False):
    """confluence-downloader/output → documents + conversions."""
    output_dir = PROJECT_ROOT / "packages" / "confluence-downloader" / "output"
    manifest_path = output_dir / "_manifest.json"

    if not output_dir.exists():
        print(f"  SKIP: {output_dir} 없음")
        return 0

    with get_conn() as conn:
        # 소스 확인/생성
        sources = {s["name"]: s for s in list_sources(conn, enabled_only=False)}
        if "게임디자인 Confluence" not in sources:
            source_id = add_source(conn, "게임디자인 Confluence", "confluence",
                                   "225378731", convert_strategy="html-to-md",
                                   properties={"description": "Project K 게임디자인 문서", "enrich_images": True})
        else:
            source_id = sources["게임디자인 Confluence"]["id"]

        count = 0
        # content.md 파일들 순회
        for content_md in sorted(output_dir.rglob("content.md")):
            rel_path = content_md.relative_to(output_dir)
            page_dir = content_md.parent
            page_name = page_dir.name

            # _meta.json에서 메타데이터 읽기
            meta_path = page_dir / "_meta.json"
            meta = {}
            if meta_path.exists():
                try:
                    meta = json.loads(meta_path.read_text(encoding="utf-8"))
                except Exception:
                    pass

            if dry_run:
                print(f"  [DRY] {page_name}")
                count += 1
                continue

            file_size = content_md.stat().st_size
            page_id = meta.get("id", str(rel_path.parent))

            # enriched 파일 확인
            enriched_path = page_dir / "content_enriched.md"
            has_enriched = enriched_path.exists()

            doc_id = upsert_document(
                conn, source_id, str(page_id), "html",
                file_size=file_size, title=meta.get("title", page_name),
                metadata={
                    "version": meta.get("version", 0),
                    "page_id": page_id,
                    "has_enriched": has_enriched,
                    "output_path": str(page_dir),
                }
            )

            # 변환 이력
            conv_id = create_conversion(conn, doc_id, "convert", "html-to-md",
                                        input_path=str(page_id), version=1)
            complete_conversion(conn, conv_id, str(content_md),
                                quality_score=1.0 if has_enriched else 0.8,
                                stats={"size": file_size, "enriched": has_enriched})

            status = "converted"
            update_document_status(conn, doc_id, status)
            count += 1

        print(f"  Confluence: {count}건 등록")

    return count


def main():
    parser = argparse.ArgumentParser(description="기존 데이터 → 파이프라인 DB 등록")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    init_db()

    print("=" * 50)
    print(f"기존 데이터 임포트 {'(DRY RUN)' if args.dry_run else ''}")
    print("=" * 50)

    print("\n[1] xlsx-extractor")
    xlsx_count = import_xlsx_extractor(dry_run=args.dry_run)

    print(f"\n[2] confluence-downloader")
    conf_count = import_confluence_downloader(dry_run=args.dry_run)

    print(f"\n{'=' * 50}")
    print(f"완료: Excel {xlsx_count}건, Confluence {conf_count}건")
    print("=" * 50)


if __name__ == "__main__":
    main()
