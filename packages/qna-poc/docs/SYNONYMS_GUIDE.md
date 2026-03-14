# SYNONYMS & SYNONYM_WORKBOOK_OVERRIDES 유지보수 가이드

> 검색 품질에 직접 영향을 미치는 핵심 사전. 평가 실패 분석 후 수정하는 것이 가장 효과적.

---

## 1. 두 사전의 역할

### SYNONYMS (유의어 사전)

```python
SYNONYMS = {
    "대미지": ["대미지 계산", "피해량", "명중률", "데미지", "데미지 계산", "Damage"],
    "성물": ["K성물", "성물 성장", "성물 재료", "성물의 성장 방향"],
}
```

**역할**: 게임 기획 용어의 유의어/별칭 매핑. 질문에서 추출한 키워드를 확장하여 올바른 기획문서(워크북)를 찾는다.

**동작 원리**:
1. `_build_system_aliases()`가 시작 시 SYNONYMS를 읽어서 **별칭 → 워크북** 매핑을 자동 구축
2. `extract_system_names(query)`가 질문에서 SYNONYMS 키/값을 감지하여 관련 워크북을 반환
3. 구조적 검색(`_structural_search`)이 해당 워크북 내에서 키워드 매칭

**키 = 대표 용어**, **값 = 별칭 리스트**. 키와 값 모두 검색어로 활용됨.

### SYNONYM_WORKBOOK_OVERRIDES (명시적 라우팅)

```python
SYNONYM_WORKBOOK_OVERRIDES = {
    "K성물": "Confluence/Design/시스템 디자인/디자인 방향/작성 중 폴더",
    "데미지": "PK_대미지 명중률 계산기",
}
```

**역할**: 자동 매핑이 잘못되는 경우, **이 용어는 반드시 이 워크북을 봐야 한다**를 직접 지정.

**언제 필요한가?**:
- 워크북 이름에 해당 용어가 포함되지 않을 때 (예: "K성물" → "작성 중 폴더")
- 동일 용어가 여러 워크북에 존재하지만 특정 워크북이 정답일 때
- Confluence 경로가 복잡해서 자동 추론이 실패할 때

---

## 2. 수정이 필요한 시점

### 평가(verify_gt_llm) FAIL 분석 시

가장 효과적인 수정 시점. 실패 패턴별 대응:

| FAIL 유형 | 증상 | 수정 대상 |
|-----------|------|-----------|
| **문서 미발견** | Planning이 잘못된 워크북으로 라우팅 | SYNONYMS + OVERRIDES |
| **부분 매칭** | 올바른 워크북이지만 다른 섹션 반환 | SYNONYMS 값 리스트에 섹션명 추가 |
| **유의어 불일치** | "데미지" vs "대미지" 같은 표기 차이 | SYNONYMS 값 리스트에 변형 추가 |

### 새 기획문서 추가 시

- Excel 워크북 또는 Confluence 페이지가 신규 추가되면 관련 용어 등록 검토
- 특히 워크북 이름이 기획 용어와 다른 경우 (예: "PK_Npc설정" ← "NPC 설정")

---

## 3. 수정 방법

### SYNONYMS 추가/수정

```python
# 새 항목 추가
"새용어": ["별칭1", "별칭2", "영문표기"],

# 기존 항목에 별칭 추가
"대미지": ["대미지 계산", "피해량", "명중률", "데미지", "데미지 계산", "Damage", "새별칭"],
```

**규칙**:
- 키는 기획문서에서 가장 자주 쓰이는 대표 용어
- 값에는 유저가 질문할 때 사용할 수 있는 모든 변형 포함
  - 한글 표기 변형: "대미지" / "데미지"
  - 영문: "Damage"
  - 축약형: "전투AI" / "전투 AI"
  - 관련 하위 개념: "대미지 계산", "명중률"
- 3글자 이상 권장 (2글자 이하는 오탐 위험)

### SYNONYM_WORKBOOK_OVERRIDES 추가/수정

```python
# Excel 워크북 라우팅
"용어": "PK_정확한_워크북명",

# Confluence 라우팅 (부분 경로 가능)
"K성물": "Confluence/Design/시스템 디자인/디자인 방향/작성 중 폴더",
```

**규칙**:
- 값은 ChromaDB에 저장된 workbook 메타데이터와 정확히 일치해야 함
- 확인 방법:
  ```python
  import chromadb
  client = chromadb.PersistentClient(path='~/.qna-poc-chroma')
  col = client.get_collection('project_k')
  r = col.get(where_document={'$contains': '찾을키워드'}, include=['metadatas'])
  for m in r['metadatas']:
      print(m['workbook'])
  ```
- Confluence의 경우 부분 경로 매칭도 지원 (코드에서 `target_wb in wb` 체크)

---

## 4. 수정 후 재인덱싱 필요 여부

| 수정 대상 | 재인덱싱 필요? | 이유 |
|-----------|:---:|------|
| SYNONYMS | **불필요** | 검색 시점에 동적으로 적용 |
| SYNONYM_WORKBOOK_OVERRIDES | **불필요** | 검색 시점에 동적으로 적용 |
| indexer.py (청킹 로직) | **필요** (`--reset`) | 청크 데이터 자체가 변경 |
| content.md (원본 변환) | **필요** (`--workbook`) | 해당 워크북만 재인덱싱 |

---

## 5. 검증 방법

### 별칭 매핑 확인

```python
from src.retriever import extract_system_names, _build_system_aliases
import src.retriever as r
r._system_aliases = {}  # 캐시 초기화
_build_system_aliases()
print(extract_system_names('K성물 기획서 어디까지 됐어?'))
# → ['Confluence/Design/시스템 디자인/디자인 방향/작성 중 폴더']
```

### 단건 답변 테스트

```python
from src.agent import agent_answer
result = agent_answer('K성물 기획서 어디까지 됐어?', role='기획자')
print(result['answer'])
```

### 전체 평가

```bash
python -m eval.verify_gt_llm              # 전체 70개
python -m eval.verify_gt_llm --ids F-001  # 특정 문항만
```

---

## 6. 주의사항

1. **SYNONYMS 키 중복 금지**: 같은 키가 두 번 나오면 뒤의 것만 적용됨
2. **OVERRIDES는 최소한으로**: 자동 매핑이 잘 동작하면 추가할 필요 없음. 실패할 때만 추가
3. **캐시 주의**: `_system_aliases`가 전역 캐시됨. 코드 수정 후 테스트 시 `r._system_aliases = {}` 초기화 필요
4. **짧은 별칭 주의**: "UI", "AI" 같은 2글자 별칭은 오탐 가능성 높음
5. **Confluence 경로는 워크북 메타데이터 기준**: 파일시스템 경로가 아님. ChromaDB에서 확인할 것
