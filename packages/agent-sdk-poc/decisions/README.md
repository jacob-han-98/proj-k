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

## 사용 예 (cwd = `packages/agent-sdk-poc`)

사전 준비: `.env`에 `AWS_BEARER_TOKEN_BEDROCK`·`AWS_REGION` 설정되어 있어야 Ranker가 Sonnet 호출 가능.

### 1. Ranker 실행

```bash
# LLM 호출 없이 스캔 대상 30개 시스템만 출력 (무료)
.venv/bin/python scripts/rank_refactor_targets.py --dry-run --limit-systems 30

# 10 시스템 실제 실행 (Sonnet, 약 3분, 약 $1.5)
.venv/bin/python scripts/rank_refactor_targets.py --dimensions conflict,hub --limit-systems 10

# 30 시스템 full (약 5분, 약 $2.5)
.venv/bin/python scripts/rank_refactor_targets.py --dimensions conflict,hub --limit-systems 30 --concurrency 8
```

결과: `decisions/refactor_targets.json` 갱신 + `_history/`·`_perf/`에 아카이브.

### 2. Ranker 결과 검수

```bash
# Citation quote 가 실제 원문에 존재하는지 감사 (Ranker 재실행 불필요)
.venv/bin/python scripts/audit_citations.py

# overlay 파일들 스키마 검증
.venv/bin/python scripts/validate_overlay.py
```

### 3. Decision 흐름 (충돌 카드 보기 → 결정 기록)

```bash
# 특정 시스템의 충돌 카드 목록 (LLM 호출 없음, 즉시)
.venv/bin/python scripts/decision_cli.py list-cards "PK_HUD 시스템"

# 카드 2번의 B안 채택 → decisions.jsonl + annotations.jsonl append
.venv/bin/python scripts/decision_cli.py apply "PK_HUD 시스템" 2 B --author jacob

# 카드 1번 보류
.venv/bin/python scripts/decision_cli.py defer "PK_변신 및 스킬 시스템" 1 --author jacob \
    --comment "기획팀 판단 필요"

# 시스템 자체를 Ranker 대상에서 제외 (intended design)
.venv/bin/python scripts/decision_cli.py dismiss "PK_퀘스트" --author jacob \
    --comment "의도된 다중 참조 허브"

# Ranker 등급 조정 제안 (예: S → A)
.venv/bin/python scripts/decision_cli.py regrade "PK_HUD 시스템" --to A --author jacob \
    --comment "medium confidence 비율이 높아 S 는 과하다 판단"
```

feedback 은 다음 Ranker 재실행 시 Judge 프롬프트에 few-shot 으로 주입되어 랭킹에 반영.

### 4. 결과 파일 직접 조회

```bash
# 상위 5개 요약
python -c "
import json
r = json.load(open('decisions/refactor_targets.json'))
for t in r['targets'][:5]:
    print(f\"[{t['grade']}] #{t['rank']} {t['name']}\")
    print(f\"  {t['rationale'][:200]}\")"

# 내 결정 / 주석 / 피드백
cat decisions/decisions.jsonl | python -m json.tool
cat decisions/annotations.jsonl | python -m json.tool
cat decisions/feedback.jsonl | python -m json.tool
```
