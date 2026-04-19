"""
build_all.py — summaries → master_index → term_index 순차 실행
================================================================
사용법:
    python scripts/build_all.py --all --workers 15       # 전체 재빌드
    python scripts/build_all.py --workbook "PK_변신"     # 특정 워크북만 summaries, 나머지 index 재생성
    python scripts/build_all.py --skip-summaries          # 요약 건너뛰고 index만 재생성
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def run(cmd: list[str]):
    print(f"\n▶ {' '.join(cmd)}")
    r = subprocess.run(cmd)
    if r.returncode != 0:
        print(f"✗ exit={r.returncode}")
        sys.exit(r.returncode)


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--all", action="store_true")
    g.add_argument("--workbook")
    g.add_argument("--space")
    g.add_argument("--sample", type=int)

    ap.add_argument("--skip-summaries", action="store_true",
                    help="summaries 빌드 건너뛰고 MASTER/TERM 인덱스만 재생성")
    ap.add_argument("--skip-existing", action="store_true", default=True,
                    help="기존 summary가 최신이면 건너뛰기 (기본 ON)")
    ap.add_argument("--workers", type=int, default=15)
    args = ap.parse_args()

    python = sys.executable

    if not args.skip_summaries:
        cmd = [python, str(HERE / "build_summaries.py"), "--workers", str(args.workers)]
        if args.skip_existing:
            cmd.append("--skip-existing")
        if args.all:
            cmd.append("--all")
        elif args.workbook:
            cmd.extend(["--workbook", args.workbook])
        elif args.space:
            cmd.extend(["--space", args.space])
        elif args.sample:
            cmd.extend(["--sample", str(args.sample)])
        else:
            print("summaries 대상 지정 필요 (--all / --workbook / --space / --sample 또는 --skip-summaries)")
            sys.exit(2)
        run(cmd)

    run([python, str(HERE / "build_master_index.py")])
    run([python, str(HERE / "build_term_index.py")])
    print("\n✓ 인덱스 빌드 완료.")


if __name__ == "__main__":
    main()
