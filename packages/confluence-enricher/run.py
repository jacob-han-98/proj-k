#!/usr/bin/env python3
"""
run.py - Confluence 이미지 보강 CLI

사용법:
    python run.py --page "신화 변신 방향성"       # 특정 페이지
    python run.py --sample 3                      # 랜덤 샘플 N개
    python run.py --all --skip-enriched           # 전체 (보강 완료 건너뜀)
    python run.py --dry-run                       # 대상/비용 확인만
    python run.py --dry-run --page "길드 디자인"  # 특정 페이지 비용 확인
"""

import sys
import os
import argparse
import random
import time
import json
from pathlib import Path

from dotenv import load_dotenv

# .env 로드 (패키지 루트)
load_dotenv(Path(__file__).parent / ".env")

# 프로젝트 루트의 confluence-downloader .env도 시도 (AWS 키 공유)
_cd_env = Path(__file__).parent.parent / "confluence-downloader" / ".env"
if _cd_env.exists():
    load_dotenv(_cd_env, override=False)

# xlsx-extractor .env도 시도 (AWS 키 공유)
_xe_env = Path(__file__).parent.parent / "xlsx-extractor" / ".env"
if _xe_env.exists():
    load_dotenv(_xe_env, override=False)

from src.enricher import enrich_page, find_image_refs

# Confluence 다운로드 출력 디렉토리
CONFLUENCE_OUTPUT = Path(__file__).parent.parent / "confluence-downloader" / "output"


def find_pages_with_images(output_dir: Path) -> list[dict]:
    """이미지가 있는 모든 페이지 찾기."""
    pages = []
    for content_md in output_dir.rglob("content.md"):
        page_dir = content_md.parent
        images_dir = page_dir / "images"
        if not images_dir.exists():
            continue

        # content.md에서 이미지 참조 확인
        md_text = content_md.read_text(encoding="utf-8")
        refs = find_image_refs(md_text)
        if not refs:
            continue

        # 제목 추출
        title = page_dir.name
        import re
        title_match = re.search(r'^title:\s*"?(.+?)"?\s*$', md_text, re.MULTILINE)
        if title_match:
            title = title_match.group(1)

        # 이미 보강되었는지 확인
        enriched = (page_dir / "content_enriched.md").exists()

        pages.append({
            "dir": str(page_dir),
            "title": title,
            "image_count": len(refs),
            "enriched": enriched,
        })

    pages.sort(key=lambda p: p["image_count"])
    return pages


def find_page_by_title(output_dir: Path, title_query: str) -> Path | None:
    """제목으로 페이지 디렉토리 찾기 (부분 일치)."""
    for content_md in output_dir.rglob("content.md"):
        page_dir = content_md.parent
        # 디렉토리명으로 먼저 확인
        if title_query.lower() in page_dir.name.lower():
            return page_dir
        # content.md frontmatter 확인
        try:
            md_text = content_md.read_text(encoding="utf-8")
            if f'title: "{title_query}"' in md_text or title_query.lower() in md_text[:500].lower():
                return page_dir
        except Exception:
            pass
    return None


def main():
    parser = argparse.ArgumentParser(description="Confluence 이미지 보강 (Vision API)")
    parser.add_argument("--page", type=str, help="보강할 페이지 제목 (부분 일치)")
    parser.add_argument("--page-dir", type=str, help="보강할 페이지 디렉토리 경로")
    parser.add_argument("--sample", type=int, help="랜덤 샘플 N개 보강")
    parser.add_argument("--all", action="store_true", help="전체 페이지 보강")
    parser.add_argument("--skip-enriched", action="store_true", help="이미 보강된 페이지 건너뛰기")
    parser.add_argument("--dry-run", action="store_true", help="대상/비용 확인만")
    parser.add_argument("--output-dir", type=str, default=str(CONFLUENCE_OUTPUT),
                        help="Confluence 출력 디렉토리")
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    if not output_dir.exists():
        print(f"ERROR: 출력 디렉토리 없음: {output_dir}")
        sys.exit(1)

    # 대상 페이지 결정
    target_dirs = []

    if args.page_dir:
        page_dir = Path(args.page_dir)
        if not page_dir.exists():
            print(f"ERROR: 디렉토리 없음: {page_dir}")
            sys.exit(1)
        target_dirs = [page_dir]

    elif args.page:
        page_dir = find_page_by_title(output_dir, args.page)
        if not page_dir:
            print(f"ERROR: 페이지 찾을 수 없음: '{args.page}'")
            print("\n이미지가 있는 페이지 목록:")
            pages = find_pages_with_images(output_dir)
            for p in pages[:20]:
                status = " [보강완료]" if p["enriched"] else ""
                print(f"  {p['title']} ({p['image_count']}개 이미지){status}")
            sys.exit(1)
        target_dirs = [page_dir]

    elif args.sample or args.all:
        pages = find_pages_with_images(output_dir)
        if args.skip_enriched:
            pages = [p for p in pages if not p["enriched"]]

        if args.sample:
            pages = random.sample(pages, min(args.sample, len(pages)))

        target_dirs = [Path(p["dir"]) for p in pages]

    else:
        # 기본: 이미지 있는 페이지 목록 표시
        pages = find_pages_with_images(output_dir)
        print(f"이미지가 있는 페이지: {len(pages)}개")
        print(f"총 이미지 참조: {sum(p['image_count'] for p in pages)}개")
        enriched_count = sum(1 for p in pages if p["enriched"])
        print(f"보강 완료: {enriched_count}개, 미완료: {len(pages) - enriched_count}개")
        print(f"\n상위 10개 (이미지 많은 순):")
        for p in sorted(pages, key=lambda x: -x["image_count"])[:10]:
            status = " [보강완료]" if p["enriched"] else ""
            print(f"  {p['image_count']:4d}개  {p['title']}{status}")
        print(f"\n사용법: python run.py --page '페이지제목' [--dry-run]")
        return

    # ── 실행 ──
    print(f"\n{'=' * 60}")
    print(f"Confluence 이미지 보강 {'(DRY RUN)' if args.dry_run else ''}")
    print(f"대상: {len(target_dirs)}개 페이지")
    print(f"모델: {os.environ.get('VISION_MODEL', 'claude-sonnet-4-5')}")
    print(f"{'=' * 60}\n")

    all_results = []
    total_start = time.time()

    for i, page_dir in enumerate(target_dirs):
        print(f"[{i + 1}/{len(target_dirs)}] {page_dir.name}")
        result = enrich_page(str(page_dir), dry_run=args.dry_run)
        all_results.append(result)
        print()

    total_elapsed = round(time.time() - total_start, 1)

    # ── 요약 ──
    print(f"{'=' * 60}")
    print(f"완료 ({total_elapsed}s)")
    total_images = sum(r.get("total_images", 0) for r in all_results)
    enriched = sum(r.get("enriched_images", 0) for r in all_results)
    total_in = sum(r.get("total_input_tokens", 0) for r in all_results)
    total_out = sum(r.get("total_output_tokens", 0) for r in all_results)

    if args.dry_run:
        print(f"대상 이미지: {total_images}개")
        # 비용 추정 (Sonnet 기준: $3/M input, $15/M output)
        est_in_tokens = total_images * 3000  # 평균 입력 토큰 추정
        est_out_tokens = total_images * 200  # 평균 출력 토큰 추정
        est_cost = (est_in_tokens * 3 + est_out_tokens * 15) / 1_000_000
        print(f"추정 비용: ~${est_cost:.2f} (Sonnet 기준)")
    else:
        print(f"보강 이미지: {enriched}/{total_images}")
        print(f"토큰: {total_in:,} input + {total_out:,} output")
        if total_in > 0:
            cost = (total_in * 3 + total_out * 15) / 1_000_000
            print(f"비용: ~${cost:.4f}")
    print(f"{'=' * 60}")

    # 결과 저장
    if not args.dry_run and all_results:
        results_path = Path(__file__).parent / "last_run_results.json"
        results_path.write_text(
            json.dumps(all_results, ensure_ascii=False, indent=2),
            encoding="utf-8"
        )


if __name__ == "__main__":
    main()
