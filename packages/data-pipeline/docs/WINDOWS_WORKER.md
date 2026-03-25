# Windows ScreenShot 워커 실행 가이드

ScreenShot(Excel COM) 단계는 Windows PC에서만 실행 가능합니다.
서버의 파이프라인 DB에 HTTP API로 접속하여 작업을 처리합니다.

## 사전 준비

```bash
# 1. 최신 코드
cd proj-k
git pull

# 2. 가상환경 + 의존성
cd packages/data-pipeline
pip install -r requirements.txt
```

## 실행

```bash
# 서버 API 주소 (Linux 서버)
set API_URL=http://서버IP:8088

# ScreenShot 워커 실행 (1개씩 처리)
python -m src.worker --id win-capture --types capture --remote %API_URL% --once

# 여러 개 병렬 (PowerShell)
1..5 | ForEach-Object { Start-Process python -ArgumentList "-m src.worker --id win-capture-$_ --types capture --remote $env:API_URL --once" }

# 데몬 모드 (계속 폴링)
python -m src.worker --id win-capture --types capture --remote %API_URL% --poll 10
```

## 확인

- Admin UI Graph에서 ScreenShot 노드의 pending/running 상태 확인
- 작업 완료 후 자동으로 Vision Convert pending이 생성됨 (서버에서 처리)

## 구조

```
Windows PC                          Linux 서버
┌─────────────┐    HTTP API    ┌──────────────────┐
│ worker.py   │ ──────────────→│ api.py :8088      │
│ --types     │  claim_job     │                  │
│   capture   │  complete_job  │ pipeline.db      │
│ --remote    │  upsert_doc    │                  │
│             │                │                  │
│ Excel COM   │                │ Vision Convert   │
│ Screenshot  │                │ (Opus 4.6)       │
└─────────────┘                └──────────────────┘
```
