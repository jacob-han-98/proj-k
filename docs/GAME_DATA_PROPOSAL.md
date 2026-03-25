# 게임 데이터시트 활용 제안서

## 배경: 두 가지 지식의 결합

Project K AI 어시스턴트는 현재 **기획서**(설계 의도, 시스템 규칙, 플로우)를 기반으로 QnA를 수행합니다.
여기에 **게임 데이터시트**(클라이언트/서버가 실제 읽는 수치 데이터)를 결합하면, AI의 답변 능력이 근본적으로 확장됩니다.

### 기획서 = "왜, 어떻게" / 데이터시트 = "무엇이, 얼마나"

| 질문 유형 | 기획서만 | + 데이터시트 |
|-----------|---------|-------------|
| "변신 시스템이 뭐야?" | 설계 의도와 규칙 설명 가능 | + 86개 변신체 전체 목록, 등급별 스탯까지 |
| "레전더리 무기 몇 개야?" | 답변 불가 | ItemEquipClass에서 Grade=Legendary 필터링 → 정확한 수 |
| "보스레이드 입장 조건?" | 기획서에 규칙만 | + BossRaidCondition에서 레벨/횟수 정확한 수치 |
| "궁사 스킬 쿨타임 비교" | 설계 문서에 일부 | + SkillClass 전체 목록에서 쿨타임 정렬 |
| "이 몬스터 어디서 나와?" | 답변 불가 | MonsterSpawn + WorldClass 조인 → 정확한 위치 |

---

## 데이터시트 현황

### 규모

| 항목 | 수치 |
|------|------|
| 데이터 테이블 (xlsx) | 73개 파일 |
| Enum 정의 파일 | 140개 파일, 1,392개 값 |
| 등록된 테이블 (TableAttribute) | 182개 |
| 테이블 간 FK 관계 | 547개 |
| 총 용량 | ~9.5MB |

### 주요 데이터 도메인

| 도메인 | 핵심 테이블 | 내용 |
|--------|------------|------|
| 캐릭터/클래스 | CharacterClass, CharacterLevelUp, CharacterExp | 3 클래스, 레벨업 스탯, 경험치 테이블 |
| 스킬 | SkillClass, SkillLevelUp, SkillAnimationDelay | 스킬 정의, 레벨업 효과, 애니메이션 |
| 변신 | MetamorphClass, MetamorphEnchant, MetamorphComposeList | 변신체, 강화, 합성 레시피 |
| 몬스터 | MonsterClass, MonsterSpawn, MonsterReward, MonsterSkill | 몬스터 스탯, 출현 위치, 드롭 테이블 |
| 아이템 | ItemEquipClass, ItemConsumeClass, ItemEtcClass, ItemBox | 장비/소모품/재료, 아이템 박스 |
| 버프/효과 | BuffClass, EffectClass, BuffOverlapRule | 버프 정의, 효과 수치, CC 중첩 규칙 |
| 퀘스트 | QuestClass, QuestObjective, Dialog, QuestReward | 퀘스트 체인, 목표, 대사, 보상 |
| 월드 | WorldClass, WorldTerritory, WorldVolume | 맵 구조, 영역, 공간 볼륨 |
| 보스레이드 | BossRaidClass, BossRaidCondition | 레이드 정의, 입장 조건 |
| 펫 | PetClass, PetStatGroup, PetEnchant | 펫 정의, 스탯, 강화 |
| 길드 | GuildClass, GuildBuff, GuildRaid | 길드 시스템 전체 |
| NPC/상점 | NpcClass, MerchantClass, MerchantProduct | NPC 배치, 상점 상품 |

### 데이터 구조 특징

- **통일된 스키마**: Row 1 = 컬럼명, Row 2 = 타입 메타데이터 (domain, type, default), Row 3+ = 데이터
- **도메인 표시**: `domain=c`(클라이언트), `s`(서버), `cs`(양쪽) — 누가 이 데이터를 쓰는지 알 수 있음
- **Enum 타입 시스템**: 140개 Enum이 모든 테이블의 타입을 정의 (예: SkillTypeEnum, GradeEnum)
- **FK 관계 네트워크**: 547개 외래키로 테이블 간 관계 명시 (몬스터→스폰→월드, 스킬→버프→효과)

---

## 제안 아키텍처: Tool Calling 기반 데이터 쿼리

### 핵심 아이디어

AI Agent가 질문을 분석하여, **기획서 검색**과 **데이터 테이블 쿼리**를 동시에 수행한 뒤, 두 결과를 교차 참조하여 답변합니다.

### Before vs After

```
[Before] 질문 → 기획서 벡터 검색 → 설계 의도 기반 답변
                                    (수치/목록 질문에 취약)

[After]  질문 → AI Planning
                  ├─ 기획서 벡터 검색 → 설계 의도/규칙
                  └─ 데이터 테이블 쿼리 → 정확한 수치/목록
                → 두 소스 교차 참조 → 완전한 답변
```

### 파이프라인 통합

기존 data-pipeline에 새로운 변환 전략(`table-parser`)으로 통합:

```
[기존 파이프라인]
Perforce 기획서(xlsx) → capture(스크린샷) → convert(Vision AI) → index(ChromaDB)
Confluence(html)     → download           → enrich(이미지보강) → index(ChromaDB)

[추가되는 파이프라인]
Perforce 데이터시트(xlsx) → crawl(변경감지) → convert(table-parser) → SQLite DB
                            ↓                                         ↓
                     Perforce sync 시               Agent가 tool calling으로 쿼리
                     자동 변경 감지
```

### Agent Tool Calling 구조

AI가 사용할 수 있는 도구 4종:

| 도구 | 용도 | 예시 |
|------|------|------|
| `retrieve` | 기획서 하이브리드 검색 | "변신 시스템 설명해줘" |
| `section_search` | 특정 워크북 집중 검색 | "PK_스킬 시스템에서 쿨타임 규칙" |
| `kg_related` | 시스템 간 관계 탐색 | "변신과 스킬의 관계" |
| **`query_game_data`** | **데이터 테이블 직접 쿼리** | **"레벨 50 이상 보스 HP 목록"** |

`query_game_data` 도구의 동작:
```
AI Planning: "이 질문은 몬스터 수치를 묻고 있으니 데이터 테이블을 조회하자"
     ↓
구조화 쿼리 생성: {table: "MonsterClass", filters: [{column: "Type", op: "=", value: "Boss"}]}
     ↓
안전한 SQL 빌드: SELECT Id, Level, MaxHp FROM MonsterClass WHERE Type = ? (parameterized)
     ↓
결과 반환: Markdown 테이블로 AI에게 전달
     ↓
AI 답변: 기획서의 설계 의도 + 데이터 테이블의 실제 수치를 결합
```

---

## 기대 효과

### 1. 답변 커버리지 확대

| 현재 (기획서만) | 추가 후 (기획서 + 데이터시트) |
|----------------|------------------------------|
| "이 시스템이 뭐야?" ✅ | + "이 시스템의 구체적 데이터는?" ✅ |
| 설계 의도 설명 ✅ | + 실제 수치/밸런스 조회 ✅ |
| 시스템 간 관계 ✅ | + 데이터 간 FK 관계 추적 ✅ |
| 플로우/시퀀스 ✅ | + 목록/필터/비교/집계 ✅ |

### 2. 역할별 활용 시나리오

**기획자**:
- "변신 등급별 스탯 차이 비교해줘" → MetamorphClass에서 등급별 집계
- "퀘스트 보상으로 레전더리 아이템을 주는 퀘스트가 있어?" → QuestReward + ItemEquipClass 조인
- "몬스터 드롭 테이블에서 특정 아이템 드롭률 확인" → MonsterReward 필터링

**프로그래머**:
- "BuffClass의 EffectId가 참조하는 EffectClass 스키마 알려줘" → describe + FK 추적
- "ContentSetting에서 PlayerCollisionRadius 값은?" → 즉시 조회
- "MonsterSpawn이 WorldVolume을 어떻게 참조해?" → FK 관계 + 기획서 설계 설명

**QA**:
- "레벨 50 보스의 HP와 공격력 범위는?" → MonsterClass 필터링
- "상점에서 살 수 있는 HP 포션 종류와 가격" → Merchant + ItemConsume 조인
- "버프 중첩 규칙이 데이터에 제대로 반영되어 있어?" → BuffOverlapRule 조회 + 기획서 교차 검증

### 3. 기획서 ↔ 데이터 교차 검증 (4단계 기획 리뷰의 기반)

가장 강력한 활용 — **기획서에 기술된 내용과 실제 데이터의 일치 여부를 자동 검증**:

- 기획서: "변신은 5등급 체계" → 데이터: MetamorphGradeInfo에 6등급(Myth) → **불일치 감지**
- 기획서: "CC는 4종" → 데이터: CcEnum에 9종 → **기획서 업데이트 필요**
- 기획서: "보스는 7시간 주기" → 데이터: BossRaidClass 크론식 확인 → **정합성 검증**

이것은 로드맵 **4단계(기획 리뷰)** 의 핵심 기반이 됩니다.

### 4. 데이터 동기화 자동화

data-pipeline 통합으로:
- Perforce get latest → 변경 감지 자동 → SQLite 재인제스트
- 기획자가 데이터시트를 수정하면 AI가 자동으로 최신 데이터를 반영
- 별도의 수동 작업 없이 항상 최신 상태 유지

---

## 기술 상세

### SQLite 기반 구조화 저장

- 데이터시트의 각 시트 → 1개 SQL 테이블 (TableAttribute.xlsx의 정식 이름 사용)
- 140개 Enum → 통합 `_enums` 테이블
- FK 관계 자동 감지 → `_fk_relationships` 테이블
- 전체 DB 크기: ~10MB (가볍고 빠름)

### 안전한 쿼리 설계

- LLM이 직접 SQL을 생성하지 않음
- 구조화된 JSON 스펙 → Python이 파라미터 바인딩된 안전한 SQL 빌드
- 테이블/컬럼 화이트리스트, 행 수 제한(500), 타임아웃(5초)
- 읽기 전용 DB 접근

### 기존 시스템과의 호환

- 기존 QnA 파이프라인에 영향 없음 (기획서 검색은 그대로 동작)
- data-pipeline의 기존 crawl → convert → index 워크플로우에 자연스럽게 통합
- `query_game_data` 도구가 DB 미존재 시 자동 비활성화 (graceful degradation)

---

## 로드맵 연결

| 현재 단계 | 이 작업의 기여 |
|-----------|--------------|
| **2단계: QnA API** | 데이터 기반 질문 커버리지 대폭 확대 (수치, 목록, 비교) |
| **3단계: 데이터 동기화** | Perforce 데이터시트 자동 동기화 파이프라인 완성 |
| **4단계: 기획 리뷰** | 기획서↔데이터 교차 검증의 핵심 인프라 |
| **5단계: 실시간 어시스턴트** | 실시간 데이터 조회 기반 피드백 가능 |
| **5-A단계: 역할별 확장** | 프로그래머/QA가 실제 데이터 기반으로 활용 가능 |

---

## 요약

**한 줄 요약**: 기획서(설계 의도)와 데이터시트(실제 수치)를 결합하여, AI가 "왜 이렇게 만들었는지"와 "실제로 무엇이 있는지"를 모두 답할 수 있게 합니다.

**핵심 가치**:
1. 수치/목록/비교 질문에 정확한 답변
2. 기획서↔데이터 정합성 자동 검증
3. Perforce 동기화로 항상 최신 데이터 유지
4. 기존 파이프라인에 자연스러운 통합
