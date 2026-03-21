"""
scheduler.py - 스케줄 기반 자동 크롤링 트리거

crawl_sources의 schedule 설정을 읽어서
주기적으로 크롤링 작업을 큐에 등록한다.

사용법:
    python -m src.scheduler              # 데몬 모드
    python -m src.scheduler --once       # 1회 체크 후 종료
    python -m src.scheduler --check-now  # 지금 실행할 소스 확인만

스케줄 옵션:
    manual   — 자동 실행 안 함 (수동 트리거만)
    hourly   — 매 시간
    daily    — 매일 03:00
    weekly   — 매주 월요일 03:00
"""

import argparse
import json
import logging
import signal
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.db import get_conn, init_db, list_sources, now_iso
from src.worker import trigger_job

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [scheduler] %(levelname)s %(message)s",
    datefmt="%H:%M:%S"
)
log = logging.getLogger("scheduler")

# 마지막 실행 시각 추적
_last_run: dict[int, str] = {}
_STATE_FILE = Path(__file__).parent.parent / "config" / ".scheduler_state.json"


def load_state():
    global _last_run
    if _STATE_FILE.exists():
        try:
            _last_run = json.loads(_STATE_FILE.read_text(encoding="utf-8"))
        except Exception:
            _last_run = {}


def save_state():
    _STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    _STATE_FILE.write_text(json.dumps(_last_run, ensure_ascii=False, indent=2), encoding="utf-8")


def should_run(source: dict) -> bool:
    """이 소스를 지금 실행해야 하는지 판단."""
    schedule = source.get("schedule", "manual")
    if schedule == "manual":
        return False

    source_id = source["id"]
    last = _last_run.get(str(source_id))
    now = datetime.now()

    if not last:
        return True

    last_dt = datetime.fromisoformat(last)

    if schedule == "hourly":
        return (now - last_dt) >= timedelta(hours=1)
    elif schedule == "daily":
        return (now - last_dt) >= timedelta(hours=20) and now.hour >= 3
    elif schedule == "weekly":
        return (now - last_dt) >= timedelta(days=6) and now.weekday() == 0 and now.hour >= 3
    else:
        return False


def check_and_trigger(dry_run: bool = False) -> list[str]:
    """스케줄 확인 → 실행할 소스에 대해 작업 등록."""
    triggered = []

    with get_conn() as conn:
        sources = list_sources(conn, enabled_only=True)

    for source in sources:
        if not should_run(source):
            continue

        name = source["name"]
        if dry_run:
            log.info(f"[DRY] 트리거 대상: {name} (schedule={source['schedule']})")
            triggered.append(name)
            continue

        log.info(f"트리거: {name}")
        trigger_job("crawl", source_id=source["id"], priority=3)
        _last_run[str(source["id"])] = now_iso()
        triggered.append(name)

    if triggered:
        save_state()

    return triggered


def run_daemon(check_interval: int = 300):
    """데몬 모드: 주기적으로 스케줄 확인."""
    running = True

    def stop(*args):
        nonlocal running
        running = False
        log.info("종료 요청")

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    log.info(f"스케줄러 시작 (체크 간격: {check_interval}s)")

    while running:
        try:
            triggered = check_and_trigger()
            if triggered:
                log.info(f"트리거됨: {', '.join(triggered)}")
            else:
                log.debug("실행할 소스 없음")
        except Exception as e:
            log.error(f"체크 실패: {e}")

        # 인터벌 대기 (1초 단위로 쪼개서 빠른 종료 지원)
        for _ in range(check_interval):
            if not running:
                break
            time.sleep(1)

    log.info("스케줄러 종료")


def main():
    parser = argparse.ArgumentParser(description="파이프라인 스케줄러")
    parser.add_argument("--once", action="store_true", help="1회 체크 후 종료")
    parser.add_argument("--check-now", action="store_true", help="실행 대상만 확인 (트리거 안 함)")
    parser.add_argument("--interval", type=int, default=300, help="체크 간격 (초, 기본 5분)")
    args = parser.parse_args()

    init_db()
    load_state()

    if args.check_now:
        with get_conn() as conn:
            sources = list_sources(conn, enabled_only=True)
        print(f"등록된 소스 {len(sources)}개:")
        for s in sources:
            run = should_run(s)
            last = _last_run.get(str(s["id"]), "없음")
            print(f"  [{'+' if run else '-'}] {s['name']} (schedule={s['schedule']}, last={last})")
        return

    if args.once:
        triggered = check_and_trigger()
        if triggered:
            print(f"트리거됨: {', '.join(triggered)}")
        else:
            print("실행할 소스 없음")
        return

    run_daemon(check_interval=args.interval)


if __name__ == "__main__":
    main()
