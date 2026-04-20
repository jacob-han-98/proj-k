"""Refactor Target Ranker 엔트리포인트 (CLI).

사용 예:
    # Step 0.1 스모크 — Conflict + Hub 2차원, 상위 30개 시스템 한정
    python scripts/rank_refactor_targets.py --dimensions conflict,hub --limit-systems 30

    # 5차원 full run
    python scripts/rank_refactor_targets.py --dimensions all

    # 재실행 시 피드백 루프 포함
    python scripts/rank_refactor_targets.py --dimensions all --feedback decisions/feedback.jsonl

결과:
    decisions/refactor_targets.json        ← 최신 리포트
    decisions/_history/refactor_targets_<ts>.json  ← 아카이브
    decisions/_perf/ranker_run_<ts>.json   ← 비용·지연 리포트
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

# 저장소 루트 import 경로 보정 (scripts/ → src/ranker 접근)
_PKG_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_PKG_ROOT))

from src.ranker import __version__ as RANKER_VERSION  # noqa: E402
from src.ranker import corpus, pipeline  # noqa: E402

IMPLEMENTED_DIMENSIONS = ["conflict", "hub"]  # Step 0.1
FUTURE_DIMENSIONS = ["staleness", "confusion", "term_drift"]
ALL_DIMENSIONS = IMPLEMENTED_DIMENSIONS + FUTURE_DIMENSIONS


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Refactor Target Ranker")
    p.add_argument(
        "--dimensions",
        default="conflict,hub",
        help='분석할 차원 콤마 구분. "all" 가능. 기본: "conflict,hub" (Step 0.1 스모크)',
    )
    p.add_argument(
        "--limit-systems",
        type=int,
        default=30,
        help="스캔 대상 시스템 수 (hub degree 상위 N). 기본 30.",
    )
    p.add_argument(
        "--concurrency",
        type=int,
        default=6,
        help="Stage 1+2의 병렬 Sonnet 호출 수. 기본 6.",
    )
    p.add_argument("--cov-model", default="sonnet", help="Conflict CoV 모델")
    p.add_argument("--hub-model", default="sonnet", help="Hub edge 분류 모델")
    p.add_argument("--judge-model", default="sonnet", help="Stage 4 Judge 모델")
    p.add_argument(
        "--feedback",
        type=Path,
        default=None,
        help="feedback.jsonl 경로 (Stage 4 Judge few-shot). 미지정 시 생략.",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="LLM 호출 없이 스캔 대상과 설정만 출력",
    )
    return p.parse_args()


def main() -> int:
    args = parse_args()
    requested = ALL_DIMENSIONS if args.dimensions == "all" else [
        d.strip() for d in args.dimensions.split(",") if d.strip()
    ]
    unknown = [d for d in requested if d not in ALL_DIMENSIONS]
    if unknown:
        print(f"[ERR] Unknown dimensions: {unknown}", file=sys.stderr)
        return 2

    # 아직 구현 안 된 차원은 경고만
    not_yet = [d for d in requested if d in FUTURE_DIMENSIONS]
    dims = [d for d in requested if d in IMPLEMENTED_DIMENSIONS]
    if not_yet:
        print(f"[warn] 아직 구현 안 된 차원 (Step 0.2에서 추가 예정): {not_yet}", file=sys.stderr)

    print(f"Ranker {RANKER_VERSION}")
    print(f"  dimensions     = {dims}")
    print(f"  limit_systems  = {args.limit_systems}")
    print(f"  concurrency    = {args.concurrency}")
    print(f"  feedback       = {args.feedback}")
    print(f"  dry_run        = {args.dry_run}")

    if args.dry_run:
        picked = corpus.top_hub_systems(args.limit_systems)
        print(f"\n[dry-run] top {args.limit_systems} by hub degree:")
        for name in picked:
            print(f"  - (deg {corpus.hub_degree(name):>3}) {name}")
        return 0

    if not dims:
        print("[ERR] No implemented dimensions selected.", file=sys.stderr)
        return 2

    report = pipeline.run(
        dimensions=dims,
        limit_systems=args.limit_systems,
        cov_model=args.cov_model,
        hub_model=args.hub_model,
        judge_model=args.judge_model,
        concurrency=args.concurrency,
        feedback_path=args.feedback,
    )
    print(f"\nTop targets ({min(5, len(report['targets']))}):")
    for t in report["targets"][:5]:
        print(f"  [{t['grade']}] #{t['rank']}  {t['name']}")
        print(f"     rationale: {(t.get('rationale') or '')[:180]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
