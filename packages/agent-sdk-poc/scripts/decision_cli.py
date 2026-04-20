"""Decision 흐름용 얇은 CLI — Ranker 결과를 받아 카드 조회 / 선택 / feedback 기록.

사용 예:
    # 특정 시스템의 충돌 카드 목록 보기 (LLM 호출 없음 — Stage 1 재활용)
    python scripts/decision_cli.py list-cards "PK_변신 및 스킬 시스템"

    # 1번 카드의 B안 채택 → decisions.jsonl / annotations.jsonl 기록
    python scripts/decision_cli.py apply "PK_변신 및 스킬 시스템" 1 B --author jacob

    # 1번 카드 보류 → feedback.jsonl (action=defer)
    python scripts/decision_cli.py defer "PK_변신 및 스킬 시스템" 1 --author jacob \
        --comment "기획팀 판단 필요"

    # 시스템 자체를 리팩토링 대상에서 제외 → feedback.jsonl (action=dismiss)
    python scripts/decision_cli.py dismiss "PK_퀘스트" --author jacob \
        --comment "의도된 다중 참조 허브, 정리 대상 아님"

    # 기록한 overlay 파일 스키마 검증
    python scripts/decision_cli.py validate

결과 파일:
    decisions/decisions.jsonl
    decisions/annotations.jsonl
    decisions/feedback.jsonl
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

PKG_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PKG_ROOT))

from src.ranker import decision  # noqa: E402


def _cmd_list_cards(args: argparse.Namespace) -> int:
    cards = decision.build_cards(args.target)
    print(f"# {args.target}  —  {len(cards)} cards\n")
    for i, c in enumerate(cards, 1):
        print(f"[{i}] severity={c.severity}  type={c.conflict_type}")
        print(f"    topic: {c.topic}")
        for o in c.options:
            snippet = (o["summary"] or "")[:160].replace("\n", " ")
            print(f"    ({o['key']}) {o['side']}: {snippet}")
        if c.recommendation:
            print(f"    💡 rec: {c.recommendation[:160]}")
        print()
    return 0


def _cmd_apply(args: argparse.Namespace) -> int:
    cards = decision.build_cards(args.target)
    idx = args.card_index - 1
    if idx < 0 or idx >= len(cards):
        print(f"[ERR] card index out of range: 1..{len(cards)}", file=sys.stderr)
        return 2
    card = cards[idx]
    d, anns = decision.apply_decision(
        args.target,
        card,
        args.option,
        author=args.author,
        ttl_days=args.ttl_days,
        selected_custom_text=args.custom,
    )
    print(f"[✓] decision {d['id']} recorded — option {args.option}")
    print(f"    deprecated refs: {len(anns)}")
    for a in anns:
        print(f"      - {a['label']}")
    return 0


def _cmd_feedback(args: argparse.Namespace, action: str) -> int:
    comment = args.comment or ""
    if args.card_index is not None:
        cards = decision.build_cards(args.target)
        idx = args.card_index - 1
        if 0 <= idx < len(cards):
            c = cards[idx]
            # 카드 맥락을 comment 앞에 prepend
            prefix = f"[{c.conflict_type}:{c.topic}] "
            if not comment.startswith(prefix):
                comment = prefix + comment
    rec = decision.record_feedback(
        args.target,
        action=action,
        author=args.author,
        comment=comment,
        regrade_to=args.regrade_to,
        ttl_days=args.ttl_days,
    )
    print(f"[✓] feedback {rec['id']} recorded — action={action}")
    print(f"    comment: {rec['comment']}")
    return 0


def _cmd_validate(_: argparse.Namespace) -> int:
    validator = PKG_ROOT / "scripts" / "validate_overlay.py"
    result = subprocess.run([sys.executable, str(validator)], check=False)
    return result.returncode


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Decision overlay CLI")
    sub = p.add_subparsers(dest="command", required=True)

    # list-cards
    l = sub.add_parser("list-cards", help="시스템의 충돌 카드 나열")
    l.add_argument("target")
    l.set_defaults(func=_cmd_list_cards)

    # apply
    a = sub.add_parser("apply", help="카드의 선택지를 결정으로 기록")
    a.add_argument("target")
    a.add_argument("card_index", type=int, help="list-cards 의 1-based index")
    a.add_argument("option", help="A/B/...  (other 는 --custom 과 함께)")
    a.add_argument("--author", required=True)
    a.add_argument("--ttl-days", type=int, default=30)
    a.add_argument("--custom", default=None, help="option=other 일 때 자유 입력")
    a.set_defaults(func=_cmd_apply)

    # defer / dismiss / regrade / comment
    for act in ("defer", "dismiss", "comment"):
        s = sub.add_parser(act, help=f"{act} 피드백 기록")
        s.add_argument("target")
        s.add_argument("--card-index", type=int, default=None, help="특정 카드 맥락")
        s.add_argument("--author", required=True)
        s.add_argument("--comment", default="")
        s.add_argument("--ttl-days", type=int, default=30)
        s.add_argument("--regrade-to", default=None, help="(regrade 전용, 여기선 무시)")
        s.set_defaults(func=lambda args, _a=act: _cmd_feedback(args, _a))

    r = sub.add_parser("regrade", help="Ranker의 등급 조정 제안 (feedback)")
    r.add_argument("target")
    r.add_argument("--to", dest="regrade_to", required=True, choices=["S", "A", "B", "C"])
    r.add_argument("--card-index", type=int, default=None)
    r.add_argument("--author", required=True)
    r.add_argument("--comment", default="")
    r.add_argument("--ttl-days", type=int, default=30)
    r.set_defaults(func=lambda args: _cmd_feedback(args, "regrade"))

    # validate
    v = sub.add_parser("validate", help="overlay 스키마 검증")
    v.set_defaults(func=_cmd_validate)

    return p.parse_args()


def main() -> int:
    args = parse_args()
    try:
        return args.func(args)
    except Exception as e:
        print(f"[ERR] {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
