#!/usr/bin/env python3
"""
rebuild_knowledge.py - 지식화 파이프라인 통합 명령

업데이트된 데이터 → 변환 → 이미지 보강 → 인덱싱 → 지식 그래프

사용법:
    python scripts/rebuild_knowledge.py                    # 전체 파이프라인
    python scripts/rebuild_knowledge.py --index-only       # 인덱싱만
    python scripts/rebuild_knowledge.py --enrich-only      # 이미지 보강만
    python scripts/rebuild_knowledge.py --dry-run          # 대상 확인만
    python scripts/rebuild_knowledge.py --changed-only     # 변경 파일만
"""

import argparse
import io
import json
import os
import subprocess
import sys
import time
from pathlib import Path

# Windows cp949 인코딩 문제 방지
if sys.stdout.encoding != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

PROJECT_ROOT = Path(__file__).parent.parent
SCRIPTS_DIR = Path(__file__).parent


def run_step(name: str, cmd: list[str], cwd: str = None, timeout: int = 600) -> dict:
    """파이프라인 단계 실행."""
    print(f"\n  [{name}]")
    print(f"    명령: {' '.join(cmd)}")
    start = time.time()

    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True,
            cwd=cwd or str(PROJECT_ROOT),
            timeout=timeout,
            encoding="utf-8", errors="replace"
        )
        elapsed = round(time.time() - start, 1)

        if result.returncode == 0:
            # 마지막 10줄만 출력
            output_lines = (result.stdout or "").strip().split("\n")
            for line in output_lines[-10:]:
                if line.strip():
                    print(f"    {line.strip()}")
            print(f"    → 완료 ({elapsed}s)")
            return {"status": "ok", "elapsed": elapsed}
        else:
            print(f"    → 실패 (exit {result.returncode}, {elapsed}s)")
            error_lines = (result.stderr or result.stdout or "").strip().split("\n")
            for line in error_lines[-5:]:
                if line.strip():
                    print(f"    {line.strip()}")
            return {"status": "error", "elapsed": elapsed, "error": result.stderr[:500]}

    except subprocess.TimeoutExpired:
        elapsed = round(time.time() - start, 1)
        print(f"    → 타임아웃 ({elapsed}s)")
        return {"status": "timeout", "elapsed": elapsed}
    except Exception as e:
        elapsed = round(time.time() - start, 1)
        print(f"    → 오류: {e}")
        return {"status": "error", "elapsed": elapsed, "error": str(e)}


def step_convert_xlsx(dry_run: bool = False, changed_only: bool = False) -> dict:
    """변경된 Excel 파일 재변환."""
    extractor_dir = PROJECT_ROOT / "packages" / "xlsx-extractor"
    run_path = extractor_dir / "run.py"

    if not run_path.exists():
        print(f"    WARNING: xlsx-extractor run.py 없음: {run_path}")
        return {"status": "skipped", "reason": "xlsx-extractor not found"}

    cmd = [sys.executable, "run.py", "--all"]
    if changed_only:
        cmd.append("--changed-only")
    if dry_run:
        cmd.append("--dry-run")

    return run_step("Excel 변환", cmd, cwd=str(extractor_dir), timeout=7200)


def step_enrich_images(dry_run: bool = False, changed_only: bool = False) -> dict:
    """Confluence 이미지 보강."""
    enricher_dir = PROJECT_ROOT / "packages" / "confluence-enricher"
    cmd = [sys.executable, "run.py", "--all", "--skip-enriched"]
    if dry_run:
        cmd.append("--dry-run")
    return run_step("이미지 보강", cmd, cwd=str(enricher_dir), timeout=3600)


def step_index(dry_run: bool = False) -> dict:
    """ChromaDB 인덱싱."""
    qna_dir = PROJECT_ROOT / "packages" / "qna-poc"
    indexer_path = qna_dir / "src" / "indexer.py"

    if not indexer_path.exists():
        print(f"    WARNING: indexer.py 없음: {indexer_path}")
        return {"status": "skipped", "reason": "indexer not found"}

    if dry_run:
        print(f"    DRY-RUN: {indexer_path} 실행 예정")
        return {"status": "dry_run"}

    cmd = [sys.executable, str(indexer_path), "--reset"]
    return run_step("ChromaDB 인덱싱", cmd, cwd=str(qna_dir), timeout=600)


def step_build_kg(dry_run: bool = False) -> dict:
    """Knowledge Graph 재빌드."""
    qna_dir = PROJECT_ROOT / "packages" / "qna-poc"
    kg_path = qna_dir / "src" / "build_kg.py"

    if not kg_path.exists():
        print(f"    WARNING: build_kg.py 없음: {kg_path}")
        return {"status": "skipped", "reason": "build_kg not found"}

    if dry_run:
        print(f"    DRY-RUN: {kg_path} 실행 예정")
        return {"status": "dry_run"}

    cmd = [sys.executable, str(kg_path)]
    return run_step("Knowledge Graph 빌드", cmd, cwd=str(qna_dir), timeout=300)


def main():
    parser = argparse.ArgumentParser(description="지식화 파이프라인")
    parser.add_argument("--dry-run", action="store_true", help="대상 확인만")
    parser.add_argument("--index-only", action="store_true", help="인덱싱만 실행")
    parser.add_argument("--enrich-only", action="store_true", help="이미지 보강만")
    parser.add_argument("--changed-only", action="store_true", help="변경 파일만 처리")
    parser.add_argument("--skip-update", action="store_true",
                        help="소스 업데이트 건너뛰기 (이미 최신이면)")
    args = parser.parse_args()

    print("=" * 60)
    print(f"지식화 파이프라인 {'(DRY RUN)' if args.dry_run else ''}")
    print("=" * 60)

    results = {}
    start = time.time()

    # 파이프라인 단계별 실행
    if args.index_only:
        steps = ["index", "build_kg"]
    elif args.enrich_only:
        steps = ["enrich"]
    else:
        steps = []
        if not args.skip_update:
            steps.append("update_sources")
        steps.extend(["convert_xlsx", "enrich", "index", "build_kg"])

    for step in steps:
        if step == "update_sources":
            print("\n[1/5] 데이터 소스 업데이트")
            cmd = [sys.executable, str(SCRIPTS_DIR / "update_sources.py"), "all"]
            if args.dry_run:
                cmd.append("--dry-run")
            results["update"] = run_step("소스 업데이트", cmd, timeout=600)

        elif step == "convert_xlsx":
            print("\n[2/5] Excel 변환 (변경분)")
            results["convert_xlsx"] = step_convert_xlsx(
                dry_run=args.dry_run,
                changed_only=args.changed_only
            )

        elif step == "enrich":
            print("\n[3/5] Confluence 이미지 보강")
            results["enrich"] = step_enrich_images(
                dry_run=args.dry_run,
                changed_only=args.changed_only
            )

        elif step == "index":
            print("\n[4/5] ChromaDB 인덱싱")
            results["index"] = step_index(dry_run=args.dry_run)

        elif step == "build_kg":
            print("\n[5/5] Knowledge Graph 빌드")
            results["build_kg"] = step_build_kg(dry_run=args.dry_run)

    elapsed = round(time.time() - start, 1)

    # 요약
    print(f"\n{'=' * 60}")
    print(f"파이프라인 완료 ({elapsed}s)")
    for step_name, result in results.items():
        status = result.get("status", "unknown")
        step_time = result.get("elapsed", 0)
        print(f"  {step_name}: {status} ({step_time}s)")
    print("=" * 60)

    # 결과 저장
    results_path = SCRIPTS_DIR / "last_pipeline_results.json"
    results["total_elapsed"] = elapsed
    results_path.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
