---
name: conflict-scan
description: "기획서 간 충돌/모순 스캔. '충돌 스캔', '기획서 모순', 'conflict scan', '문서 충돌 확인', '기획서 검증' 등을 요청하면 트리거."
---

# 기획서 충돌 스캐너

기획서 간의 수치 모순, 규칙 충돌, 용어 불일치를 자동 감지합니다.

## 실행

```bash
cd "c:/Users/jacob.JACOB-D/Documents/proj-k 기획/packages/qna-poc"
PYTHONUTF8=1 python -u -m src.conflict_scanner
```

결과 파일:
- `eval/conflict_scan_latest.json` — 구조화된 충돌 데이터
- `eval/conflict_scan_latest.md` — 사람이 읽기 좋은 마크다운 보고서

## Gotchas

- **ChromaDB 필수**: 지식 베이스가 인덱싱되어 있어야 함. 없으면 `/index-qna --reset` 먼저
- **Bedrock API 비용**: 문서 쌍마다 LLM 호출. 전체 스캔은 수십 회 호출 발생
- **PYTHONUTF8=1 필수**: Windows 한글 인코딩
- **결과 해석 주의**: LLM이 판단한 "충돌"이 실제로는 의도된 설계 차이일 수 있음. 기획자 검증 필요
- **실행 시간**: 문서 쌍 수에 비례. 47쌍 기준 약 5~10분

## 결과 분석 (실행 후)

1. `eval/conflict_scan_latest.md` 읽기
2. 충돌 유형별 분류:
   - **수치 모순**: 같은 값이 문서마다 다름 (예: 최대 레벨이 60 vs 70)
   - **규칙 충돌**: 상위 규칙과 하위 규칙이 모순
   - **용어 불일치**: 같은 개념에 다른 용어 사용
3. 심각도별 우선순위 정렬
4. 기획자에게 전달할 요약 작성
