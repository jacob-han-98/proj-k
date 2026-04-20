# Refactor Target Ranker — Judge Rubric

Stage 4 (LLM-as-Judge)가 따르는 등급 기준과 프레이밍 원칙. 이 문서의 텍스트는 **Judge 프롬프트에 그대로 주입**된다.

## 절대 원칙 (프레이밍)

**이 리포트는 기획자의 기존 작업물에 대한 평가다. 다음을 엄수하라:**

1. **"작업이 나쁘다"라고 말하지 않는다.** 대신 "정리하면 기획자·Agent 양쪽에 이득" 구도로 rationale을 쓴다.
2. **책임 귀속 금지.** "누가 잘못 썼다", "빠뜨렸다" 같은 표현 금지. 항상 문서 상태를 기술한다 ("X와 Y가 상이한 상태", "Confluence에 개편안이 있으나 Excel 반영 미확인").
3. **용어는 "점수" 대신 "정리 가치(Cleanup Value)"**. 등급은 **S/A/B/C**로 표기. 숫자 점수는 breakdown으로만 따로 기록.
4. **Confidence 필수.** 증거가 희박하거나 도메인이 모호한 경우 반드시 `confidence_flags`에 플래그.
5. **환각 금지.** rationale의 모든 주장은 verified_evidence의 cited_text로 뒷받침되어야 한다. 추측·일반화는 하지 않는다.

## 등급 정의

| 등급 | 의미 | 조건 (가이드라인) |
|---|---|---|
| **S** | 정리가 매우 권장됨 — 다차원이 동시에 높고 blast radius가 큼 | 3개 이상 차원에서 verified_evidence ≥ 2건, 또는 단일 차원에서 evidence ≥ 4건이면서 hub 상위 | 
| **A** | 정리 권장 — 차원 2~3개가 확실히 신호 보이거나 blast radius 큼 | 2개 이상 차원에서 verified_evidence ≥ 2건, confidence high/medium 우세 |
| **B** | 여유될 때 정리 — 신호는 있으나 blast radius 작거나 차원이 단일 | 1~2개 차원 evidence, blast_radius 작음 |
| **C** | 관찰 대상 — 지금은 정리 이득 미미, 주기적 모니터링 | evidence 희박 또는 self_consistency 흔들림 |

## 차원별 판정 가이드

### Conflict Density
- 같은 시스템 내 또는 긴밀히 연결된 시스템 간 **숫자·규칙·정의의 상충**.
- 의도된 "(구버전)", "이전 안", "archived" 표기는 충돌로 치지 않는다 (CoV에서 걸러짐).
- 여러 시트에서 같은 공식이 다른 값으로 등장하면 high confidence.

### Hub / Blast Radius
- 그래프 degree는 초벌값. **의존 유형을 의미로 분류**하라:
  - 강한 의존 (공식 참조, 데이터 모델 공유) → 가중치 ×1.5
  - 약한 참조 (언급만) → 가중치 ×0.5
- "이 시스템이 틀리면 구체적으로 X, Y, Z가 어떻게 영향받는가"를 자연어로 rationale에 포함.

### Staleness Signal
- Confluence에 "개편안/개선/신규" 성격 페이지가 있고 **Excel 본문이 그 방향을 반영하지 않은 것처럼 보이면** staleness.
- 단, "개편안" 페이지 자체가 검토 단계일 수 있으니 Excel이 Confluence보다 뒤처져 있다고 단정하지 말 것. 항상 양쪽 quote를 evidence로.
- "히스토리" 시트의 존재 자체는 staleness가 아니다.

### Confusion Signal
- 실제 대화 로그에서 사용자가 같은 시스템에 대해 **혼란을 표시한 세션**이 누적된 경우.
- 후속질문 반복, "어느게 맞냐", "상충", "모순" 등의 표현을 Sonnet이 문맥 판정 (정규식 아님).
- 세션 수가 적으면 confidence low.

### Term Drift
- 같은 개념이 한국어/영문/약어/별칭으로 분산되어 여러 시트에 쓰이면 drift.
- 글로서리와 교차 검증. 글로서리가 명시한 표준어와 다른 표기가 2회 이상이면 evidence.

## 프롬프트 템플릿 앵커 (Judge 호출 시 동적 삽입)

```
<few_shots>
{사용자 피드백(feedback.jsonl)에서 최근 유효한 것 주입}
</few_shots>

<dimension_scores>
{Stage 3 출력 — 시스템별 차원별 점수·rationale}
</dimension_scores>

<verified_evidence>
{Stage 2 CoV 통과 evidence — 각 cited_text + source + confidence}
</verified_evidence>
```

Judge는 위 입력만으로 등급·rationale·blast_radius 추정·confidence_flags를 산출한다. **외부 지식 추가 금지.**
