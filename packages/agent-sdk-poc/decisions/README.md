# Decisions & Annotations Overlay

기획서 리팩토링 워크플로우의 **overlay 레이어** — 원본 Excel/Confluence는 수정하지 않고 여기에만 기록한다.

## 파일 구조

```
decisions/
├── refactor_targets.json       # Ranker 실행 결과 (Top N 후보 + 등급 + rationale + evidence)
├── decisions.jsonl             # Append-only Decision Journal (사용자 확정한 충돌 해결안)
├── annotations.jsonl           # Append-only Annotation Overlay (deprecated 마킹)
├── feedback.jsonl              # 사용자의 Ranker 피드백 (dismiss / regrade / 의견)
├── schema/                     # JSON Schema 정의 (validate_overlay.py가 참조)
│   ├── decision.schema.json
│   ├── annotation.schema.json
│   ├── refactor_targets.schema.json
│   └── feedback.schema.json
├── config/
│   └── ranker_rubric.md        # Judge에게 주는 등급 기준 (S/A/B/C 정의 + 프레이밍 원칙)
├── _history/                   # refactor_targets 실행 아카이브 (gitignore)
└── _perf/                      # Stage별 비용·지연 로그 (gitignore)
```

## 운영 원칙

1. **Append-only**: `decisions.jsonl`·`annotations.jsonl`·`feedback.jsonl` 은 **절대 기존 줄을 수정하지 않는다**. 취소·수정은 새 줄로 append (`status: "revoked"` 등).
2. **원본 불침습**: Excel/Confluence는 수정하지 않는다. 모든 정리 이력은 여기에.
3. **TTL 관리**: annotation의 `expires_at` 도래 후 복원 없으면 별도 cleanup runbook이 하드 삭제 후보 리포트 제시 (Agent 단독 원본 삭제 금지).
4. **검증 필수**: 파일 수정 후 `python scripts/validate_overlay.py` 로 JSON Schema 검증.

## 관련 문서

- 계획: `/home/jacob/.claude/plans/https-cp-tech2-hybe-im-proj-k-agentsdk-quiet-salamander.md`
- Ranker 모듈: `src/ranker/`
- 실행 스크립트: `scripts/rank_refactor_targets.py`
