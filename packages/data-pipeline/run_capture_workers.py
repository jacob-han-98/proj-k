"""
capture 워커 병렬 실행 런처

Excel COM은 클립보드를 사용하므로 동시 실행 시 간헐적 실패 가능.
실패 시 작업은 pending으로 돌아가 다음 워커가 재처리한다.

사용법:
    python run_capture_workers.py                # 기본 5개
    python run_capture_workers.py --workers 3    # 3개
    python run_capture_workers.py --workers 1    # 순차 (안전)
"""

import argparse
import subprocess
import sys
import time
import os
from pathlib import Path
from datetime import datetime

PACKAGE_DIR = Path(__file__).parent
LOG_DIR = PACKAGE_DIR / "logs"
LOG_DIR.mkdir(exist_ok=True)

REMOTE_URL = os.getenv("PIPELINE_API_URL", "http://localhost:8088")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--workers", type=int, default=5, help="동시 워커 수")
    parser.add_argument("--remote", default=REMOTE_URL, help="서버 API URL")
    args = parser.parse_args()

    n = args.workers
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    procs = []

    print(f"=== Capture Workers x{n} 시작 ({args.remote}) ===")
    print(f"로그: {LOG_DIR}/")

    for i in range(n):
        worker_id = f"win-cap-{i+1}"
        log_file = LOG_DIR / f"capture_{worker_id}_{timestamp}.log"

        with open(log_file, "w", encoding="utf-8") as lf:
            proc = subprocess.Popen(
                [sys.executable, "-m", "src.worker",
                 "--id", worker_id,
                 "--types", "capture",
                 "--remote", args.remote,
                 "--poll", "5"],
                stdout=lf,
                stderr=subprocess.STDOUT,
                cwd=str(PACKAGE_DIR),
            )
            procs.append((worker_id, proc, log_file))
            print(f"  [{worker_id}] PID={proc.pid} → {log_file.name}")

    print(f"\n모든 워커 실행 중. 진행 상황 확인:")
    print(f"  tail -f {LOG_DIR}/capture_win-cap-*_{timestamp}.log")
    print(f"  curl -s {args.remote}/admin/pipeline/dag | python -m json.tool")
    print(f"\n중지: Ctrl+C")

    try:
        while True:
            alive = [(wid, p) for wid, p, _ in procs if p.poll() is None]
            if not alive:
                print("\n모든 워커 종료됨.")
                break
            time.sleep(10)

            # 간단 상태 표시
            completed = sum(1 for _, p, _ in procs if p.poll() is not None)
            print(f"  [{datetime.now().strftime('%H:%M:%S')}] "
                  f"활성 {len(alive)}/{n} 워커", end="", flush=True)

            # pending 작업 수 확인
            try:
                import requests
                r = requests.get(f"{args.remote}/admin/pipeline/jobs/stats", timeout=5)
                if r.ok:
                    stats = r.json()
                    pending = stats.get("pending", 0)
                    running = stats.get("running", 0)
                    print(f" | 대기 {pending}, 실행중 {running}", flush=True)
                else:
                    print("", flush=True)
            except Exception:
                print("", flush=True)

    except KeyboardInterrupt:
        print("\n\n워커 종료 중...")
        for wid, proc, _ in procs:
            if proc.poll() is None:
                proc.terminate()
                print(f"  [{wid}] terminated")

        # 3초 대기 후 강제 종료
        time.sleep(3)
        for wid, proc, _ in procs:
            if proc.poll() is None:
                proc.kill()
                print(f"  [{wid}] killed")

    # 최종 결과 요약
    print("\n=== 완료 요약 ===")
    for wid, proc, log_file in procs:
        rc = proc.returncode if proc.returncode is not None else "running"
        # 로그에서 '캡처 완료' 라인 수 카운트
        try:
            log_text = log_file.read_text(encoding="utf-8", errors="replace")
            done_count = log_text.count("캡처 완료") + log_text.count("capture complete")
            # completed job count
            job_done = log_text.count("작업 완료") + log_text.count("Job completed")
            print(f"  [{wid}] exit={rc}, 완료={job_done}건, 로그: {log_file.name}")
        except Exception:
            print(f"  [{wid}] exit={rc}")


if __name__ == "__main__":
    main()
