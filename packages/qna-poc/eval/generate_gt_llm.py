"""
LLM 기반 GT 질문 생성기.

content.md 파일을 Claude Sonnet에 전달하여
실제 기획자/프로그래머/QA/PM이 물어볼 법한 자연어 질문을 생성한다.

사용법:
    python -m eval.generate_gt_llm --sample 1      # 1파일 테스트
    python -m eval.generate_gt_llm --sample 5      # 5파일 테스트
    python -m eval.generate_gt_llm --dry-run       # 샘플링 계획만
    python -m eval.generate_gt_llm                 # 전체 실행
    python -m eval.generate_gt_llm --resume        # 중단 후 이어서
"""

import argparse
import json
import random
import sys
import time
from pathlib import Path

# ── 경로 ──────────────────────────────────────────────────
ROOT = Path(__file__).resolve().parent.parent          # packages/qna-poc
PROJ_ROOT = ROOT.parent.parent                          # proj-k 기획
EXTRACTOR_OUTPUT = ROOT.parent / "xlsx-extractor" / "output"
CONFLUENCE_OUTPUT = ROOT.parent / "confluence-downloader" / "output"
KG_PATH = PROJ_ROOT / "_knowledge_base" / "knowledge_graph.json"
RESULTS_DIR = Path(__file__).resolve().parent / "results"
OUTPUT_PATH = RESULTS_DIR / "gt_questions_llm.json"
PROGRESS_PATH = RESULTS_DIR / ".gt_llm_progress.json"

# ── call_bedrock 임포트 ───────────────────────────────────
sys.path.insert(0, str(ROOT))
from src.generator import call_bedrock  # noqa: E402


# ══════════════════════════════════════════════════════════
#  파일 탐색
# ══════════════════════════════════════════════════════════

def scan_excel_files() -> list[Path]:
    """xlsx-extractor output에서 _final/content.md 스캔."""
    if not EXTRACTOR_OUTPUT.exists():
        return []
    return sorted(EXTRACTOR_OUTPUT.glob("**/_final/content.md"))


def scan_confluence_files() -> list[Path]:
    """Confluence output에서 content_enriched.md 우선, 없으면 content.md."""
    if not CONFLUENCE_OUTPUT.exists():
        return []
    files = []
    for content_md in sorted(CONFLUENCE_OUTPUT.rglob("content.md")):
        if content_md.parent == CONFLUENCE_OUTPUT:
            continue
        enriched = content_md.parent / "content_enriched.md"
        target = enriched if enriched.exists() else content_md
        try:
            if target.stat().st_size < 100:
                continue
        except OSError:
            continue
        files.append(target)
    return files


def extract_workbook_name(filepath: Path) -> str:
    """파일 경로에서 워크북/시스템 이름 추출."""
    parts = filepath.parts
    # Excel: .../output/PK_xxx/시트/_final/content.md
    if "_final" in parts:
        idx = parts.index("_final")
        if idx >= 2:
            return parts[idx - 2]  # PK_xxx
    # Confluence: .../output/Design/xxx/.../content.md
    if "confluence-downloader" in str(filepath):
        try:
            out_idx = parts.index("output")
            rel = "/".join(parts[out_idx + 1:len(parts) - 1])
            return f"Confluence/{rel}"
        except ValueError:
            pass
    return filepath.parent.name


def extract_sheet_name(filepath: Path) -> str:
    """파일 경로에서 시트 이름 추출."""
    parts = filepath.parts
    if "_final" in parts:
        idx = parts.index("_final")
        if idx >= 1:
            return parts[idx - 1]
    return filepath.parent.name


# ══════════════════════════════════════════════════════════
#  층화 샘플링
# ══════════════════════════════════════════════════════════

def stratified_sample(
    excel_files: list[Path],
    confluence_files: list[Path],
    n_excel: int = 150,
    n_confluence: int = 100,
) -> list[dict]:
    """Excel + Confluence 파일을 층화 샘플링."""
    random.seed(42)

    excel_sample = random.sample(excel_files, min(n_excel, len(excel_files)))
    conf_sample = random.sample(confluence_files, min(n_confluence, len(confluence_files)))

    result = []
    for f in excel_sample:
        result.append({"path": f, "source": "excel", "workbook": extract_workbook_name(f), "sheet": extract_sheet_name(f)})
    for f in conf_sample:
        result.append({"path": f, "source": "confluence", "workbook": extract_workbook_name(f), "sheet": extract_sheet_name(f)})

    random.shuffle(result)
    return result


# ══════════════════════════════════════════════════════════
#  KG 클러스터 추출
# ══════════════════════════════════════════════════════════

def load_kg_clusters(max_clusters: int = 30) -> list[list[str]]:
    """knowledge_graph.json에서 관련 시스템 클러스터 추출."""
    if not KG_PATH.exists():
        print("[WARN] knowledge_graph.json not found, skipping cross-system questions.")
        return []

    with open(KG_PATH, "r", encoding="utf-8") as f:
        kg = json.load(f)

    systems = kg.get("systems", {})
    # 관계 밀도 높은 시스템 우선
    scored = []
    for name, info in systems.items():
        related = info.get("related_systems", [])
        if len(related) >= 2:
            scored.append((name, related, len(related)))

    scored.sort(key=lambda x: -x[2])

    clusters = []
    used = set()
    for name, related, _ in scored:
        if name in used:
            continue
        # 2~3개 시스템으로 클러스터 구성
        cluster = [name]
        for r in related[:3]:
            if r not in used and r in systems:
                cluster.append(r)
                if len(cluster) >= 3:
                    break
        if len(cluster) >= 2:
            clusters.append(cluster)
            used.update(cluster)
        if len(clusters) >= max_clusters:
            break

    return clusters


def find_content_for_system(system_name: str) -> Path | None:
    """시스템 이름으로 content.md 경로 찾기."""
    # Excel: PK_xxx → output/PK_xxx/*/_final/content.md (첫 번째 시트)
    if not system_name.startswith("Confluence/"):
        pattern = f"{system_name}/**/_final/content.md"
        matches = sorted(EXTRACTOR_OUTPUT.glob(pattern))
        # PK_ 접두사 추가 시도
        if not matches:
            matches = sorted(EXTRACTOR_OUTPUT.glob(f"PK_{system_name}/**/_final/content.md"))
        if matches:
            return matches[0]
    else:
        # Confluence: Confluence/Design/xxx → output/Design/xxx/content.md
        rel = system_name.replace("Confluence/", "")
        candidate = CONFLUENCE_OUTPUT / rel / "content_enriched.md"
        if candidate.exists():
            return candidate
        candidate = CONFLUENCE_OUTPUT / rel / "content.md"
        if candidate.exists():
            return candidate
    return None


# ══════════════════════════════════════════════════════════
#  질문 생성 프롬프트
# ══════════════════════════════════════════════════════════

GENERATION_SYSTEM_PROMPT = """당신은 모바일 MMORPG "Project K"의 기획 문서를 읽고,
실제 개발팀이 슬랙에서 물어볼 법한 자연스러운 질문을 생성하는 전문가입니다.

## 질문 생성 규칙

1. **역할별 질문 스타일**:
   - 기획자: "이거 어떻게 동작해?", "A랑 B 차이가 뭐야?", "이 수치 맞아?"
   - 프로그래머: "이 테이블 컬럼명이 뭐야?", "예외 처리 어떻게 해?", "이 플로우 구현할 때..."
   - QA: "이 케이스 테스트하려면...", "경계값이 뭐야?", "이거 버그 아니야?"
   - PM: "이거 누가 담당이야?", "마지막으로 수정된 게 언제야?", "일정에 영향 있어?"
   - 아트/연출: "이 이펙트 사양이 어떻게 돼?", "리소스 규격이..."

2. **난이도**:
   - easy: 문서에서 바로 찾을 수 있는 단일 사실 (1~2문장으로 답 가능)
   - medium: 문서 내 여러 섹션을 종합해야 답할 수 있는 것
   - hard: 여러 문서를 연결해야 답할 수 있는 것

3. **카테고리**:
   - A: 사실 조회 (수치, 이름, 조건 등)
   - C: 밸런스 (등급별 비교, 수치 밸런스)
   - D: 플로우 (시퀀스, 예외 처리, 분기)
   - E: UI (화면 구성, 버튼 동작, 진입 방법)
   - F: 메타 (작성자, 수정일, 히스토리)

4. **말투**: 슬랙 업무체. 존댓말/반말 혼용. 게임 은어 자연스럽게 사용.
   - 예: "쿨감 어떻게 적용돼?", "합성 실패하면 재료 날아가?", "이 표 좀 이상한데"

5. **질문 품질 규칙** (매우 중요):
   - 질문이 특정 케이스/조건에 의존하는 경우, 반드시 그 전제 조건을 질문에 포함하세요.
     - BAD: "소형 물약 다 쓰면 중형으로 전환돼?" (어떤 물약을 소지 중인지 불명확)
     - GOOD: "소형/중형/대형 물약 다 있을 때 소형 다 쓰면 뭘로 바뀌어?" (전제 명시)
   - 답변은 기본 규칙/원칙을 먼저 설명하고, 특정 케이스는 그 다음에 부연하세요.
   - 문서의 특정 Case/예시만 발췌하지 말고, 해당 섹션의 전체 맥락을 이해한 질문을 만드세요.
   - **"이 문서", "이 시트", "여기서" 같은 지시대명사를 절대 사용하지 마세요.**
     구체적인 시스템명/기능명을 포함하세요.
     - BAD: "이 문서 마지막 수정일이 언제야?" (어떤 문서인지 불명확)
     - GOOD: "몬스터설정 기획서 마지막 수정일이 언제야?" (문서명 명시)
   - **질문에 워크북/시스템 이름을 포함하세요.** QnA 시스템이 어떤 문서를 찾아야 하는지 알 수 있게.
     - BAD: "높낮이가 몇 단계로 나뉘어?" (어떤 시스템의 높낮이인지 모름)
     - GOOD: "녹시온 필드 기획서에서 높낮이가 몇 단계로 나뉘어?" (워크북 힌트 포함)
   - **문서의 서술적 내용(규칙, 흐름, 구조)에 대해 질문하세요.**
     원본 Excel 표의 개별 셀 값(특정 몬스터 ID, 정확한 수치)보다는
     규칙, 공식, 동작 흐름, 시스템 구조에 대한 질문이 답변 가능성이 높습니다.
     - BAD: "CeletaneSoldier_Shield_A가 어디 지역 몹이야?" (특정 행 데이터)
     - GOOD: "몬스터 네이밍 규칙이 어떻게 되는 거야? 접두사별 의미가 뭐야?" (규칙/구조)
   - **⚠️ 이미지 해석 의존 질문 금지** (절대 규칙):
     문서에 `> **[이미지 설명]**:` 형식으로 시작하는 텍스트는 AI가 이미지를 분석한 내용입니다.
     이 이미지 설명에만 존재하는 정보로 질문을 만들지 마세요.
     테이블, 본문 텍스트, 수치 데이터 등 **서술적/구조적 텍스트에 명시된 정보**만으로 답할 수 있는 질문을 생성하세요.
     - BAD: "녹시온 필드의 이동불가 지역 색상이 뭐야?" (이미지 설명에서만 확인 가능)
     - BAD: "이 다이어그램에서 화살표가 어디를 가리키고 있어?" (이미지 의존)
     - GOOD: "물약 자동 사용 쿨타임 기본값이 몇 초야?" (테이블 데이터)

6. **각 질문에 반드시 포함할 것**:
   - expected_answer: 정답 (문서 내용 기반, 2~5문장). 기본 규칙을 먼저, 케이스별 상세는 후순위로.
   - key_facts: 정답의 핵심 사실 리스트 (2~5개). 기본 규칙이 첫 번째.
   - rationale: 이 질문을 하게 된 맥락/상황 설명
   - expected_workbooks: 이 질문의 답을 찾을 수 있는 워크북명 리스트

## 출력 형식

JSON 배열로 출력하세요. 다른 텍스트 없이 JSON만 출력합니다.

```json
[
  {
    "query": "질문 텍스트",
    "category": "A|C|D|E|F",
    "role": "기획자|프로그래머|QA|PM|아트",
    "difficulty": "easy|medium",
    "expected_answer": "정답 텍스트",
    "key_facts": ["사실1", "사실2"],
    "rationale": "이 질문을 하게 된 맥락",
    "expected_workbooks": ["워크북명"]
  }
]
```"""

CROSS_SYSTEM_PROMPT = """당신은 모바일 MMORPG "Project K"의 기획 문서를 읽고,
**여러 문서를 종합해야 답할 수 있는** 크로스 시스템 질문을 생성하는 전문가입니다.

아래에 관련된 2~3개 시스템의 기획 문서가 제공됩니다.
이 문서들을 **함께 읽어야만** 답할 수 있는 질문을 1~2개 생성하세요.

## 규칙
- 단일 문서만 봐서는 답할 수 없는 질문이어야 합니다
- 시스템 간 연결점, 의존성, 충돌 가능성을 탐색하세요
- 난이도: hard
- 카테고리: B (시스템간)
- 역할: 기획자 또는 프로그래머
- 슬랙 업무체 사용
- **⚠️ 이미지 해석 의존 금지**: `> **[이미지 설명]**:` 형식의 텍스트는 AI 이미지 분석 결과입니다. 이 내용에만 존재하는 정보로 질문하지 마세요. 테이블/본문 텍스트 기반 질문만 생성하세요.

## 출력 형식

JSON 배열로 출력하세요. 다른 텍스트 없이 JSON만 출력합니다.

```json
[
  {
    "query": "질문 텍스트",
    "category": "B",
    "role": "기획자|프로그래머",
    "difficulty": "hard",
    "expected_answer": "정답 텍스트 (두 문서를 종합한 답변)",
    "key_facts": ["사실1", "사실2"],
    "rationale": "이 질문을 하게 된 맥락",
    "required_systems": ["시스템1", "시스템2"]
  }
]
```"""

HALLUCINATION_TRAP_PROMPT = """당신은 모바일 MMORPG "Project K"의 기획 문서를 잘 알고 있는 전문가입니다.

아래 문서를 읽고, **문서에 존재하지 않는 기능/시스템에 대해 마치 있는 것처럼 묻는**
할루시네이션 트랩 질문을 2~3개 생성하세요.

## 규칙
- 질문은 그럴듯하지만, 실제 문서에는 해당 내용이 없어야 합니다
- 예: "변신 분해하면 강화석 나온다던데?" (실제로는 분해 기능 없음)
- 좋은 QnA 시스템은 "해당 내용이 기획서에 없다"고 답해야 합니다
- expected_answer에 "해당 기능은 기획서에 정의되어 있지 않다"는 내용 포함
- **⚠️ 이미지 해석 의존 금지**: 트랩 질문도 이미지 설명(`> **[이미지 설명]**:`)에만 의존하지 마세요. 문서의 텍스트/테이블 내용을 기반으로 그럴듯한 트랩을 만드세요.

## 출력 형식

JSON 배열로 출력하세요. 다른 텍스트 없이 JSON만 출력합니다.

```json
[
  {
    "query": "그럴듯하지만 존재하지 않는 기능에 대한 질문",
    "category": "H",
    "role": "기획자",
    "difficulty": "trap",
    "expected_answer": "해당 기능은 기획서에 정의되어 있지 않다. 현재는 X와 Y만 가능하다.",
    "key_facts": ["해당 기능 미존재", "실제 가능한 기능"],
    "rationale": "존재하지 않는 기능을 마치 있는 것처럼 질문하는 트랩"
  }
]
```"""


# ══════════════════════════════════════════════════════════
#  질문 생성 코어
# ══════════════════════════════════════════════════════════

def read_content(filepath: Path, max_chars: int = 15000) -> str:
    """content.md 파일 내용 읽기 (토큰 제한을 위해 잘라냄)."""
    try:
        text = filepath.read_text(encoding="utf-8")
        if len(text) > max_chars:
            text = text[:max_chars] + "\n\n...(이하 생략)..."
        return text
    except Exception as e:
        print(f"  [WARN] Failed to read {filepath}: {e}")
        return ""


def parse_llm_json(text: str) -> list[dict]:
    """LLM 응답에서 JSON 배열 추출 (복구 로직 포함)."""
    import re as _re
    text = text.strip()
    # ```json ... ``` 블록 추출
    if "```json" in text:
        start = text.index("```json") + 7
        end = text.find("```", start)
        if end >= 0:
            text = text[start:end].strip()
        else:
            text = text[start:].strip()
    elif "```" in text:
        start = text.index("```") + 3
        end = text.find("```", start)
        if end >= 0:
            text = text[start:end].strip()
        else:
            text = text[start:].strip()
    # [ ... ] 추출
    bracket_start = text.find("[")
    bracket_end = text.rfind("]")
    if bracket_start >= 0 and bracket_end > bracket_start:
        text = text[bracket_start:bracket_end + 1]

    # 1차: 그대로 파싱
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # 2차: JSON 문자열 내부 줄바꿈을 \n으로 치환
    def _fix_newlines_in_strings(s: str) -> str:
        result = []
        in_string = False
        escape = False
        for ch in s:
            if escape:
                result.append(ch)
                escape = False
                continue
            if ch == '\\':
                result.append(ch)
                escape = True
                continue
            if ch == '"':
                in_string = not in_string
                result.append(ch)
                continue
            if in_string and ch == '\n':
                result.append('\\n')
                continue
            result.append(ch)
        return ''.join(result)

    fixed = _fix_newlines_in_strings(text)
    try:
        return json.loads(fixed)
    except json.JSONDecodeError:
        pass

    # 3차: 개별 JSON 객체 추출
    results = []
    for m in _re.finditer(r'\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}', text, _re.DOTALL):
        obj_text = _fix_newlines_in_strings(m.group())
        try:
            obj = json.loads(obj_text)
            if "query" in obj:
                results.append(obj)
        except json.JSONDecodeError:
            continue
    if results:
        return results

    print(f"  [WARN] JSON parse failed after all attempts")
    print(f"  [WARN] Raw text: {text[:300]}...")
    return []


def generate_questions_for_file(
    filepath: Path,
    workbook: str,
    sheet: str,
    source: str,
) -> list[dict]:
    """단일 파일에 대해 2~5개 질문 생성."""
    content = read_content(filepath)
    if not content:
        return []

    user_msg = f"""## 문서 정보
- 워크북: {workbook}
- 시트: {sheet}
- 소스: {source}

## 문서 내용

{content}

---

위 문서를 읽고 2~5개의 자연어 질문을 생성하세요.
역할(기획자/프로그래머/QA/PM)과 난이도(easy/medium)를 다양하게 섞어주세요."""

    try:
        result = call_bedrock(
            messages=[{"role": "user", "content": user_msg}],
            system=GENERATION_SYSTEM_PROMPT,
            model="claude-sonnet-4-5",
            max_tokens=4096,
            temperature=0.7,
        )
    except Exception as e:
        print(f"  [ERROR] API call failed: {e}")
        return []

    questions = parse_llm_json(result["text"])

    # 메타데이터 추가
    for q in questions:
        q["expected_workbooks"] = [workbook]
        q["ground_truth_source"] = str(filepath.relative_to(PROJ_ROOT))
        q["is_hallucination_trap"] = False

    tokens = result.get("input_tokens", 0) + result.get("output_tokens", 0)
    print(f"  → {len(questions)} questions, {tokens} tokens, {result.get('api_seconds', 0):.1f}s")
    return questions


def generate_cross_system_questions(clusters: list[list[str]]) -> list[dict]:
    """KG 클러스터 기반 크로스 시스템 질문 생성."""
    all_questions = []

    for i, cluster in enumerate(clusters):
        print(f"  [Cross {i+1}/{len(clusters)}] {' + '.join(cluster)}")

        # 각 시스템의 content.md 읽기
        docs = []
        workbooks = []
        for sys_name in cluster:
            path = find_content_for_system(sys_name)
            if path:
                content = read_content(path, max_chars=8000)
                if content:
                    docs.append(f"### 시스템: {sys_name}\n\n{content}")
                    workbooks.append(sys_name)

        if len(docs) < 2:
            print(f"    → 문서 부족, 스킵")
            continue

        user_msg = f"""## 관련 시스템 문서들

{chr(10).join(docs)}

---

위 {len(docs)}개 시스템 문서를 종합해야 답할 수 있는 질문 1~2개를 생성하세요."""

        try:
            result = call_bedrock(
                messages=[{"role": "user", "content": user_msg}],
                system=CROSS_SYSTEM_PROMPT,
                model="claude-sonnet-4-5",
                max_tokens=4096,
                temperature=0.7,
            )
        except Exception as e:
            print(f"    [ERROR] API call failed: {e}")
            continue

        questions = parse_llm_json(result["text"])
        for q in questions:
            q["expected_workbooks"] = workbooks
            q["ground_truth_source"] = f"cross-system: {', '.join(cluster)}"
            q["is_hallucination_trap"] = False
            q.setdefault("category", "B")
            q.setdefault("difficulty", "hard")

        print(f"    → {len(questions)} questions")
        all_questions.extend(questions)

    return all_questions


def generate_hallucination_traps(sample_files: list[dict], count: int = 45) -> list[dict]:
    """할루시네이션 트랩 질문 생성."""
    all_traps = []
    # 다양한 시스템에서 트랩 생성
    trap_sources = random.sample(sample_files, min(20, len(sample_files)))

    for i, file_info in enumerate(trap_sources):
        if len(all_traps) >= count:
            break
        print(f"  [Trap {i+1}/{len(trap_sources)}] {file_info['workbook']}")

        content = read_content(file_info["path"], max_chars=8000)
        if not content:
            continue

        user_msg = f"""## 문서 정보
- 워크북: {file_info['workbook']}
- 시트: {file_info['sheet']}

## 문서 내용

{content}

---

위 문서를 읽고 할루시네이션 트랩 질문 2~3개를 생성하세요."""

        try:
            result = call_bedrock(
                messages=[{"role": "user", "content": user_msg}],
                system=HALLUCINATION_TRAP_PROMPT,
                model="claude-sonnet-4-5",
                max_tokens=2048,
                temperature=0.8,
            )
        except Exception as e:
            print(f"    [ERROR] {e}")
            continue

        traps = parse_llm_json(result["text"])
        for t in traps:
            t["expected_workbooks"] = []
            t["ground_truth_source"] = None
            t["is_hallucination_trap"] = True
            t.setdefault("category", "H")
            t.setdefault("difficulty", "trap")

        print(f"    → {len(traps)} traps")
        all_traps.extend(traps)

    return all_traps[:count]


# ══════════════════════════════════════════════════════════
#  ID 부여 & 중복 제거
# ══════════════════════════════════════════════════════════

def assign_ids(questions: list[dict]) -> list[dict]:
    """카테고리별 ID 부여."""
    counters = {}
    for q in questions:
        cat = q.get("category", "A")
        counters.setdefault(cat, 0)
        counters[cat] += 1
        q["id"] = f"GT-LLM-{cat}-{counters[cat]:03d}"
    return questions


def deduplicate(questions: list[dict]) -> list[dict]:
    """유사 질문 중복 제거 (단순 문자열 기반)."""
    seen = set()
    unique = []
    for q in questions:
        query_norm = q["query"].strip().lower()
        # 앞 20자가 같으면 중복으로 간주
        key = query_norm[:20]
        if key not in seen:
            seen.add(key)
            unique.append(q)
    return unique


def trim_to_target(questions: list[dict], target: int) -> list[dict]:
    """카테고리별 균형을 유지하며 목표 수로 트리밍."""
    if target <= 0 or len(questions) <= target:
        return questions

    # 카테고리별 분류
    by_cat = {}
    for q in questions:
        cat = q.get("category", "A")
        by_cat.setdefault(cat, []).append(q)

    # 카테고리별 목표 비율 (대략적)
    target_ratios = {"A": 0.18, "B": 0.14, "C": 0.10, "D": 0.18, "E": 0.08, "F": 0.08, "H": 0.14}
    # 나머지 카테고리는 균등 배분
    known_cats = set(target_ratios.keys())
    unknown_cats = set(by_cat.keys()) - known_cats
    if unknown_cats:
        remaining_ratio = max(0, 1.0 - sum(target_ratios.values())) / max(1, len(unknown_cats))
        for cat in unknown_cats:
            target_ratios[cat] = remaining_ratio

    # 카테고리별 할당
    result = []
    for cat, pool in by_cat.items():
        ratio = target_ratios.get(cat, 0.1)
        n = max(1, round(target * ratio))
        n = min(n, len(pool))
        random.shuffle(pool)
        result.extend(pool[:n])

    # 목표보다 부족하면 남은 질문에서 채움
    if len(result) < target:
        used_ids = {id(q) for q in result}
        remaining = [q for q in questions if id(q) not in used_ids]
        random.shuffle(remaining)
        result.extend(remaining[:target - len(result)])

    # 목표보다 많으면 트리밍
    if len(result) > target:
        random.shuffle(result)
        result = result[:target]

    return result


# ══════════════════════════════════════════════════════════
#  진행 상태 저장/복구
# ══════════════════════════════════════════════════════════

def save_progress(questions: list[dict], processed_files: list[str]):
    """진행 상태 저장."""
    data = {
        "questions": questions,
        "processed_files": processed_files,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    with open(PROGRESS_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def load_progress() -> tuple[list[dict], set[str]]:
    """진행 상태 복구."""
    if not PROGRESS_PATH.exists():
        return [], set()
    with open(PROGRESS_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data.get("questions", []), set(data.get("processed_files", []))


# ══════════════════════════════════════════════════════════
#  메인
# ══════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description="LLM 기반 GT 질문 생성기")
    parser.add_argument("--sample", type=int, default=0, help="테스트용 파일 수 (0=전체)")
    parser.add_argument("--dry-run", action="store_true", help="샘플링 계획만 확인")
    parser.add_argument("--resume", action="store_true", help="중단 후 이어서")
    parser.add_argument("--no-cross", action="store_true", help="크로스 시스템 질문 생략")
    parser.add_argument("--no-traps", action="store_true", help="할루시네이션 트랩 생략")
    parser.add_argument("--target", type=int, default=0, help="최종 목표 질문 수 (0=제한없음). 초과 시 카테고리별 균형 유지하며 트리밍")
    args = parser.parse_args()

    # results 디렉토리 생성
    RESULTS_DIR.mkdir(exist_ok=True)

    print("=" * 60)
    print("  LLM 기반 GT 질문 생성기")
    print("=" * 60)

    # 파일 스캔
    excel_files = scan_excel_files()
    confluence_files = scan_confluence_files()
    print(f"\n[INFO] Excel files: {len(excel_files)}")
    print(f"[INFO] Confluence files: {len(confluence_files)}")

    # 샘플링
    if args.sample > 0:
        n_excel = max(1, int(args.sample * 0.6))
        n_conf = max(1, args.sample - n_excel)
        sample = stratified_sample(excel_files, confluence_files, n_excel, n_conf)
    else:
        sample = stratified_sample(excel_files, confluence_files)

    print(f"[INFO] Sampled: {len(sample)} files "
          f"(Excel {sum(1 for s in sample if s['source']=='excel')}, "
          f"Confluence {sum(1 for s in sample if s['source']=='confluence')})")

    if args.dry_run:
        print("\n[DRY-RUN] 샘플링 결과:")
        for i, s in enumerate(sample[:20]):
            print(f"  {i+1}. [{s['source']}] {s['workbook']} / {s['sheet']}")
        if len(sample) > 20:
            print(f"  ... 외 {len(sample) - 20}개")

        clusters = load_kg_clusters()
        print(f"\n[DRY-RUN] KG 클러스터: {len(clusters)}개")
        for i, c in enumerate(clusters[:5]):
            print(f"  {i+1}. {' + '.join(c)}")

        est_api_calls = len(sample) + len(clusters) + 20
        print(f"\n[DRY-RUN] 예상 API 호출: ~{est_api_calls}")
        print(f"[DRY-RUN] 예상 비용: ~${est_api_calls * 0.02:.2f}")
        return

    # 진행 상태 복구
    all_questions = []
    processed = set()
    if args.resume:
        all_questions, processed = load_progress()
        print(f"[INFO] Resumed: {len(all_questions)} questions, {len(processed)} files processed")

    # ── Phase 1: 단일 문서 질문 생성 ──
    t0 = time.time()
    total = len(sample)
    for i, file_info in enumerate(sample):
        file_key = str(file_info["path"])
        if file_key in processed:
            continue

        elapsed = time.time() - t0
        remaining = (elapsed / max(i, 1)) * (total - i) if i > 0 else 0
        print(f"\n[{i+1}/{total}] {file_info['workbook']}/{file_info['sheet']} "
              f"({elapsed:.0f}s elapsed, ~{remaining:.0f}s remaining)")

        questions = generate_questions_for_file(
            file_info["path"],
            file_info["workbook"],
            file_info["sheet"],
            file_info["source"],
        )
        all_questions.extend(questions)
        processed.add(file_key)

        # 10파일마다 진행 저장
        if (i + 1) % 10 == 0:
            save_progress(all_questions, list(processed))
            print(f"  [SAVE] {len(all_questions)} questions so far")

    print(f"\n[INFO] 단일 문서 질문: {len(all_questions)}개 ({time.time()-t0:.0f}s)")

    # ── Phase 2: 크로스 시스템 질문 ──
    if not args.no_cross:
        print(f"\n{'='*60}")
        print(f"  크로스 시스템 질문 생성")
        print(f"{'='*60}")
        clusters = load_kg_clusters()
        if args.sample > 0:
            clusters = clusters[:max(3, args.sample)]
        cross_questions = generate_cross_system_questions(clusters)
        all_questions.extend(cross_questions)
        print(f"[INFO] 크로스 시스템 질문: {len(cross_questions)}개")

    # ── Phase 3: 할루시네이션 트랩 ──
    if not args.no_traps:
        print(f"\n{'='*60}")
        print(f"  할루시네이션 트랩 생성")
        print(f"{'='*60}")
        if args.target > 0:
            trap_count = max(5, round(args.target * 0.15))
        elif args.sample == 0:
            trap_count = 45
        else:
            trap_count = max(3, args.sample)
        traps = generate_hallucination_traps(sample, trap_count)
        all_questions.extend(traps)
        print(f"[INFO] 할루시네이션 트랩: {len(traps)}개")

    # ── 후처리 ──
    all_questions = deduplicate(all_questions)
    if args.target > 0:
        print(f"\n[INFO] 트리밍: {len(all_questions)}개 → 목표 {args.target}개")
        all_questions = trim_to_target(all_questions, args.target)
    all_questions = assign_ids(all_questions)

    # 저장
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(all_questions, f, ensure_ascii=False, indent=2)

    # 진행 파일 정리
    if PROGRESS_PATH.exists():
        PROGRESS_PATH.unlink()

    # ── 통계 ──
    total_time = time.time() - t0
    cats = {}
    roles = {}
    diffs = {}
    for q in all_questions:
        cats[q.get("category", "?")] = cats.get(q.get("category", "?"), 0) + 1
        roles[q.get("role", "?")] = roles.get(q.get("role", "?"), 0) + 1
        diffs[q.get("difficulty", "?")] = diffs.get(q.get("difficulty", "?"), 0) + 1

    print(f"\n{'='*60}")
    print(f"  생성 완료")
    print(f"{'='*60}")
    print(f"  총 질문 수: {len(all_questions)}")
    print(f"  소요 시간: {total_time:.0f}s ({total_time/60:.1f}min)")
    print(f"\n  카테고리별:")
    for cat in sorted(cats.keys()):
        print(f"    {cat}: {cats[cat]}")
    print(f"\n  역할별:")
    for role in sorted(roles.keys()):
        print(f"    {role}: {roles[role]}")
    print(f"\n  난이도별:")
    for diff in sorted(diffs.keys()):
        print(f"    {diff}: {diffs[diff]}")
    print(f"\n  출력: {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
