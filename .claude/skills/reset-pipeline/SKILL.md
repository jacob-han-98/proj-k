---
name: reset-pipeline
description: "파이프라인 테스트 데이터 리셋. '리셋', 'reset', '다운로드 지워', '작업 지워', 'pending 삭제', '다시 다운로드', '테스트 초기화' 등을 요청하면 트리거."
argument-hint: "[--source N] [--after-stage STATUS] [--reset-crawl-time] [--jobs-only] [--all-jobs]"
---

# 파이프라인 테스트 데이터 리셋

테스트/개발 중 파이프라인 상태를 되돌리는 스킬.

## 스크립트 위치

`packages/data-pipeline/scripts/reset_pipeline.py`

## 실행 예시

```bash
# 모든 pending 작업 삭제
python packages/data-pipeline/scripts/reset_pipeline.py --all-jobs

# Confluence 소스의 다운로드 이후 단계 리셋 (downloaded → crawled로)
python packages/data-pipeline/scripts/reset_pipeline.py --source 2 --after-stage crawled

# Confluence 크롤 시각도 초기화 (full crawl 강제)
python packages/data-pipeline/scripts/reset_pipeline.py --source 2 --after-stage crawled --reset-crawl-time

# dry-run으로 확인만
python packages/data-pipeline/scripts/reset_pipeline.py --source 2 --after-stage crawled --dry-run
```

## 소스 ID 참고

| ID | 이름 | 타입 |
|----|------|------|
| 1 | 7_System 기획서 | perforce |
| 2 | Confluence | confluence |

## 주의사항

- 반드시 `--dry-run`으로 먼저 확인
- running 작업이 있으면 worker가 꼬일 수 있으므로 worker 중지 후 실행 권장
- 리셋 후 DAG에서 해당 단계를 재실행하면 됨

## Gotchas

- `--after-stage crawled`는 downloaded/converted/enriched 문서를 모두 crawled로 되돌림
- last_crawl_at을 지우면 다음 크롤이 full crawl이 되어 시간이 오래 걸릴 수 있음
