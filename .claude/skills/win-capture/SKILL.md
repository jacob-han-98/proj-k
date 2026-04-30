---
name: win-capture
description: "Windows 캡처 워커 프로세스 관리. '캡처 워커', 'capture worker', '캡처 상태', '캡처 실행', '캡처 종료', '캡처 중지', '워커 몇개', '엑셀 프로세스' 등을 요청하면 트리거."
argument-hint: "[status|stop|start [N]|restart [N]|kill-excel]"
---

# Windows 캡처 워커 관리

WSL2에서 Windows 캡처 워커 프로세스를 조회/종료/실행한다.

## 워커 경로

- 런처: `C:\Users\jacob.JACOB-D\Documents\proj-k 기획\packages\data-pipeline\run_capture_workers.py`
- 워커 코드: `packages/data-pipeline/src/worker.py`
- 작업 디렉토리: `/mnt/c/Users/jacob.JACOB-D/Documents/proj-k 기획/packages/data-pipeline`

## 명령별 실행

### status (기본) — 현재 상태 조회

```bash
echo "=== Windows 캡처 워커 프로세스 ==="
wmic.exe process where "name like 'python%'" get ProcessId,CommandLine 2>/dev/null | grep -i "capture" | while IFS= read -r line; do
  pid=$(echo "$line" | grep -oP '\d+\s*$' | tr -d ' ')
  cmd=$(echo "$line" | sed "s/$pid\s*$//")
  echo "  PID=$pid  $cmd"
done

echo ""
echo "=== Excel 프로세스 ==="
tasklist.exe /FI "IMAGENAME eq EXCEL.EXE" 2>/dev/null | grep -i excel || echo "  없음"

echo ""
echo "=== 서버 작업큐 (capture) ==="
curl -s "http://localhost:8088/admin/pipeline/jobs?job_type=capture&limit=1" 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    stats = data.get('stats', {})
    print(f'  pending={stats.get(\"pending\",0)}  running={stats.get(\"running\",0)}  assigned={stats.get(\"assigned\",0)}  completed={stats.get(\"completed\",0)}  failed={stats.get(\"failed\",0)}')
except: print('  API 조회 실패')
" 2>/dev/null

echo ""
echo "=== 하트비트 (활성 워커) ==="
curl -s "http://localhost:8088/admin/pipeline/dag" 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    workers = data.get('workers', {})
    cap = workers.get('capture', 0)
    print(f'  capture 워커: {cap}대 (하트비트 기준)')
except: print('  조회 실패')
" 2>/dev/null
```

### stop — 캡처 워커 전체 종료

```bash
echo "=== 캡처 워커 종료 ==="
# run_capture_workers.py (런처) + src.worker capture 프로세스 모두 종료
wmic.exe process where "name like 'python%' AND CommandLine like '%capture%'" get ProcessId 2>/dev/null | grep -oP '\d+' | while read pid; do
  taskkill.exe /PID "$pid" /F 2>/dev/null
  echo "  종료: PID=$pid"
done

echo ""
echo "=== 좀비 Excel 정리 ==="
taskkill.exe /IM EXCEL.EXE /F 2>/dev/null && echo "  Excel 종료됨" || echo "  실행 중인 Excel 없음"
```

### start [N] — 캡처 워커 실행 (기본 1개)

인자에서 워커 수 N을 파싱한다 (기본값: 1).

```bash
WIN_CWD="/mnt/c/Users/jacob.JACOB-D/Documents/proj-k 기획/packages/data-pipeline"
N=${1:-1}  # 인자에서 워커 수 파싱, 기본 1

echo "=== 캡처 워커 ${N}개 실행 ==="
cd "$WIN_CWD" && cmd.exe /C "start /MIN python run_capture_workers.py --workers $N --remote http://localhost:8088" 2>/dev/null
echo "  run_capture_workers.py --workers $N 실행됨"
echo "  잠시 후 status로 확인하세요"
```

### restart [N] — 종료 후 재실행

stop → 3초 대기 → start N 순서로 실행.

### kill-excel — Excel 프로세스만 강제 종료

```bash
taskkill.exe /IM EXCEL.EXE /F 2>/dev/null && echo "Excel 종료됨" || echo "실행 중인 Excel 없음"
```

## 실행 방식

- WSL2에서 `wmic.exe`, `taskkill.exe`, `tasklist.exe`, `cmd.exe`로 Windows 프로세스를 제어
- 워커는 `cmd.exe /C start /MIN`으로 백그라운드 실행 (WSL 터미널과 독립)
- 서버 API(`localhost:8088`)로 작업큐 상태 조회

## Gotchas

- **워커 수 주의**: Excel COM은 클립보드를 공유하므로 동시 5개 이상은 실패율 급증. 안정적 운영은 1~3개 권장
- **좀비 Excel**: 워커가 비정상 종료되면 EXCEL.EXE가 남음. `kill-excel`로 정리 후 재시작
- **assigned 작업**: 워커를 강제 종료하면 assigned 상태 작업이 남음. 워커 재시작 시 `_cleanup_stale_jobs()`가 자동 정리
- **로그 확인**: Windows 측 로그는 `packages/data-pipeline/logs/capture_win-cap-*_*.log`에 저장됨
- **RPC 서버 오류 반복**: Excel COM이 불안정해지면 `stop → kill-excel → start`로 완전 리셋
