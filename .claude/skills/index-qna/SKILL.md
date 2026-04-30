---
name: index-qna
description: "ChromaDB 지식 베이스 재인덱싱 + 성능 추적. '인덱싱', '재인덱싱', 'reindex', 'ChromaDB 업데이트', '지식 베이스 갱신' 등을 요청하면 트리거."
argument-hint: "[--reset] [--source excel|confluence|all]"
---

# ChromaDB 인덱서

QnA 지식 베이스를 재구축합니다.

## 인자

- `--reset` → 기존 DB 삭제 후 처음부터 인덱싱 (권장)
- `--source excel` → Excel만 인덱싱
- `--source confluence` → Confluence만 인덱싱
- 인자 없음 → 기존 데이터에 추가 (주의: 중복 발생 가능)

## 실행

설정값은 `${CLAUDE_SKILL_DIR}/config.json`을 참조.

```bash
cd "c:/Users/jacob.JACOB-D/Documents/proj-k 기획/packages/qna-poc"
PYTHONUTF8=1 python -u -m src.indexer --reset
```

주의: 약 5~7분 소요 (병렬 임베딩 10 workers). 백그라운드 실행 권장.

## Gotchas

- **--reset 없이 실행 = 중복**: 기존 컬렉션에 추가되므로 같은 청크가 2배로 늘어남. 데이터 변경 후에는 반드시 `--reset` 사용
- **PYTHONUTF8=1 필수**: Windows 한글 파일명 인코딩 에러의 원인. 모든 Python 실행에 붙일 것
- **XLSX 소스 경로 자동 스킵**: `D:/ProjectK/Design/` 하위 경로가 없으면 Excel 인덱싱을 **경고 없이 스킵**함. Perforce sync 안 된 상태에서 인덱싱하면 Confluence만 들어감
- **ChromaDB 경로 = ~/.qna-poc-chroma**: 사용자 홈 디렉토리 기반. 다른 사용자로 실행하면 다른 DB를 사용하게 됨
- **임베딩 API throttling**: Titan Embeddings 동시 호출 10개가 한계. workers 수 늘리면 429 에러
- **서버와 동시 실행 금지**: API 서버(uvicorn)가 ChromaDB를 점유하고 있으면 lock 충돌. 인덱싱 전 서버 중단 필수
- **인덱싱 중 중단하면 불완전 DB**: Ctrl+C로 중단하면 일부 청크만 들어간 상태. 반드시 `--reset`으로 재실행
- **content_enriched.md 우선**: Confluence 페이지는 `content_enriched.md`가 있으면 그걸 사용, 없으면 `content.md`. 보강(enrichment) 안 된 페이지는 이미지 정보 누락

## 완료 후 확인

1. 총 청크 수 (예상: ~3,000~4,200)
2. Excel vs Confluence 비율
3. 임베딩 시간 및 throughput
4. OOXML supplement 적용 비율

## 다음 단계

인덱싱 완료 후 반드시 `/eval-qna --sample 10`으로 품질 확인.
데이터 변경이 크면 전체 평가 `/eval-qna` 실행 권장.
