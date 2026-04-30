"""E2E Test: 테이블 셀 수정안 생성 + Confluence 적용 테스트

테스트 흐름:
1. Confluence 페이지 (테이블 포함) HTML 가져오기
2. getTableAwareText 로직으로 셀 경계 보존 텍스트 생성
3. 백엔드 리뷰 실행 → 리뷰 항목 수집
4. LLM으로 수정안 생성 (셀 단위 before/after)
5. 검증: before가 원본 HTML에서 매칭되는지, 셀을 넘지 않는지

실행: python tests/e2e_edit_suggestion.py
"""
import sys
import time
import json
import re
import base64
import requests
from pathlib import Path
from html.parser import HTMLParser
from bs4 import BeautifulSoup

# ── Config ──
CONFLUENCE_PAGE = "https://bighitcorp.atlassian.net/wiki/spaces/PKTEST/pages/5760320533/2"
CONFLUENCE_EMAIL = "jacob@hybecorp.com"
EXTENSION_DIR = str(Path(__file__).parent.parent.resolve())

config_text = (Path(EXTENSION_DIR) / "lib" / "config.js").read_text()
API_TOKEN = re.search(r"confluenceApiToken:\s*['\"]([^'\"]+)['\"]", config_text).group(1)
BEDROCK_TOKEN = re.search(r"bedrockToken:\s*['\"]([^'\"]+)['\"]", config_text).group(1)
BACKEND_URL = re.search(r"backendUrl:\s*['\"]([^'\"]+)['\"]", config_text).group(1)
BEDROCK_MODEL = "claude-opus-4-6"
BEDROCK_REGION = "us-east-1"

AUTH = (CONFLUENCE_EMAIL, API_TOKEN)
CONFLUENCE_BASE = "https://bighitcorp.atlassian.net"


def log(msg: str):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}")


def get_table_aware_text(html_str: str) -> str:
    """Python equivalent of content.js getTableAwareText()"""
    soup = BeautifulSoup(html_str, "html.parser")
    parts = []

    def walk(node):
        if isinstance(node, str):
            # NavigableString (text node)
            parts.append(str(node))
            return

        tag = node.name if node.name else ""

        if tag == "table":
            parts.append("\n\n")
            rows = node.find_all("tr")
            header_done = False
            for row in rows:
                cells = row.find_all(["td", "th"])
                if not cells:
                    continue
                cell_texts = [
                    re.sub(r"[\n\r]+", " ", c.get_text()).strip()
                    for c in cells
                ]
                parts.append("| " + " | ".join(cell_texts) + " |\n")
                if not header_done:
                    parts.append("| " + " | ".join("---" for _ in cell_texts) + " |\n")
                    header_done = True
            parts.append("\n")
            return  # Don't recurse into table children

        block_tags = {"p", "div", "h1", "h2", "h3", "h4", "h5", "h6",
                      "li", "ul", "ol", "blockquote", "section", "article", "pre", "hr"}
        if tag in block_tags:
            parts.append("\n")
        if tag == "br":
            parts.append("\n")
            return

        for child in node.children:
            walk(child)

        if tag in block_tags:
            parts.append("\n")

    walk(soup)
    result = "".join(parts)
    result = re.sub(r"\n{3,}", "\n\n", result).strip()
    return result


def call_bedrock(system_prompt: str, user_prompt: str, max_tokens: int = 8192) -> str:
    """Direct Bedrock API call"""
    import boto3
    from botocore.config import Config

    # Decode token
    decoded = base64.b64decode(BEDROCK_TOKEN).decode()
    parts = decoded.split(":")
    access_key = parts[0].replace("BedrockAPIKey-", "").replace("3mry-at-", "")
    # Use session token approach
    # Actually, the token format is a bearer token for Bedrock
    # Let's use requests directly

    url = f"https://bedrock-runtime.{BEDROCK_REGION}.amazonaws.com/model/anthropic.{BEDROCK_MODEL}/invoke"

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {BEDROCK_TOKEN}",
    }

    body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": max_tokens,
        "system": system_prompt,
        "messages": [{"role": "user", "content": user_prompt}],
    }

    resp = requests.post(url, headers=headers, json=body, timeout=120)
    if not resp.ok:
        raise Exception(f"Bedrock API failed: {resp.status_code} {resp.text[:200]}")

    data = resp.json()
    return data["content"][0]["text"]


def call_backend_ask(question: str, text: str) -> str:
    """Backend /ask endpoint for simple LLM calls"""
    resp = requests.post(
        f"{BACKEND_URL}/ask",
        json={"question": question, "model": BEDROCK_MODEL},
        timeout=300,
    )
    if not resp.ok:
        raise Exception(f"Backend /ask failed: {resp.status_code}")
    return resp.json()


def escape_html_text(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def run_test():
    page_id = CONFLUENCE_PAGE.split("/pages/")[1].split("/")[0]

    # ── Step 1: Confluence 페이지 가져오기 ──
    log(f"Step 1: Confluence 페이지 가져오기 (ID: {page_id})")
    resp = requests.get(
        f"{CONFLUENCE_BASE}/wiki/rest/api/content/{page_id}?expand=body.storage,version",
        auth=AUTH,
    )
    if not resp.ok:
        log(f"❌ 페이지 접근 실패: {resp.status_code}")
        return False

    page_data = resp.json()
    title = page_data["title"]
    storage_html = page_data["body"]["storage"]["value"]
    version = page_data["version"]["number"]
    log(f"  제목: {title}, 버전: v{version}, HTML: {len(storage_html)}자")

    # ── Step 2: 테이블 존재 확인 + table-aware text 생성 ──
    log("Step 2: Table-aware text 생성")
    soup = BeautifulSoup(storage_html, "html.parser")
    tables = soup.find_all("table")
    log(f"  테이블 수: {len(tables)}")

    if len(tables) == 0:
        log("⚠️ 테이블이 없는 페이지. 테이블이 있는 페이지로 테스트하세요.")
        # 테이블 없어도 기본 동작 테스트는 진행

    plain_text = soup.get_text(separator="\n")
    table_aware_text = get_table_aware_text(storage_html)

    log(f"  plain text: {len(plain_text)}자")
    log(f"  table-aware text: {len(table_aware_text)}자")

    # 테이블 마크다운 변환 확인
    pipe_lines = [l for l in table_aware_text.split("\n") if l.strip().startswith("|")]
    log(f"  마크다운 테이블 행 수: {len(pipe_lines)}")

    if tables and pipe_lines:
        log(f"  ✅ 테이블이 마크다운 형식으로 변환됨")
        # 첫 번째 테이블 행 샘플
        for line in pipe_lines[:3]:
            log(f"    {line[:100]}")
    elif tables:
        log(f"  ❌ 테이블이 있지만 마크다운 변환 실패")
        return False

    # ── Step 3: 백엔드 리뷰 실행 → 리뷰 항목 수집 ──
    log(f"Step 3: 백엔드 리뷰 ({BACKEND_URL}/review_stream)")
    t0 = time.time()

    review_resp = requests.post(
        f"{BACKEND_URL}/review_stream",
        json={"title": title, "text": plain_text, "model": BEDROCK_MODEL},
        stream=True,
        timeout=600,
    )

    if not review_resp.ok:
        log(f"❌ 리뷰 API 실패: {review_resp.status_code}")
        return False

    review_result = None
    for line in review_resp.iter_lines(decode_unicode=True):
        if not line:
            continue
        try:
            event = json.loads(line)
            if event["type"] == "status":
                log(f"  {event['message']}")
            elif event["type"] == "result":
                review_result = event["data"]
            elif event["type"] == "error":
                log(f"  ❌ 에러: {event['message']}")
                return False
        except json.JSONDecodeError:
            pass

    elapsed = time.time() - t0
    if not review_result:
        log(f"❌ 리뷰 결과 없음 ({elapsed:.1f}s)")
        return False

    log(f"  ✅ 리뷰 완료 ({elapsed:.1f}s)")

    # 리뷰 JSON 파싱
    review_text = review_result.get("review", "")
    cleaned = re.sub(r"```json\s*", "", review_text)
    cleaned = re.sub(r"```\s*", "", cleaned).strip()

    try:
        match = re.search(r"\{[\s\S]*\}", cleaned)
        review = json.loads(match.group(0)) if match else None
    except Exception as e:
        log(f"  ❌ 리뷰 JSON 파싱 실패: {e}")
        return False

    issues = review.get("issues", [])
    verifications = review.get("verifications", [])
    suggestions = review.get("suggestions", [])
    log(f"  보강: {len(issues)}, 검증: {len(verifications)}, 제안: {len(suggestions)}")

    # ── Step 4: 수정안 생성 (table-aware text 사용) ──
    log("Step 4: 수정안 생성 (table-aware text 기반)")

    # 리뷰 항목으로 수정 instruction 구성
    all_items = []
    for item in issues[:3]:  # 최대 3개만 테스트
        t = item.get("text", "") if isinstance(item, dict) else item
        all_items.append(f"[⚠️ 보강 필요] {t}")
    for item in suggestions[:2]:  # 최대 2개만 테스트
        t = item.get("text", "") if isinstance(item, dict) else item
        all_items.append(f"[💡 제안] {t}")

    if not all_items:
        log("⚠️ 수정할 리뷰 항목 없음. 기본 instruction 사용")
        all_items = ["[💡 제안] 문서의 첫 번째 항목에 더 구체적인 설명을 추가해주세요"]

    instruction = f"다음 리뷰 항목을 반영하여 문서를 수정해주세요:\n" + \
                  "\n".join(f"{i+1}. {it}" for i, it in enumerate(all_items))

    log(f"  수정 항목 {len(all_items)}건")

    # Edit suggestion prompt (background.js와 동일)
    system_prompt = """You are an editor for Confluence wiki pages. Propose text changes as a JSON array.

CRITICAL RULES:
- "before": COPY-PASTE an exact substring from the page text. It MUST appear verbatim. Keep it short (1 sentence max, no newlines, no tabs).
- "after": the REPLACEMENT text that will REPLACE "before". It must contain the full corrected version of "before", NOT just the addition.
  - WRONG: before="HP 물약" after="HP 물약 (자동 사용 포함)" ← this ADDS text instead of replacing
  - RIGHT: before="HP 물약을 사용한다" after="HP 물약을 자동으로 사용한다" ← this REPLACES the sentence
- If you need to ADD new content, use "before" as the sentence AFTER which the content should appear, and "after" as that sentence + the new content.
- Each change must be SMALL: 1-2 sentences only.
- Return ONLY a raw JSON array. No markdown fences. No explanation.
- Ensure valid JSON: escape quotes with \\", no literal newlines in strings.
- Generate one change per instruction item. Do NOT skip items.
- When referencing other documents: you do NOT know which documents actually exist. Never invent document names or links. Instead, write "[TODO: 관련 문서 링크 추가 필요]" so the author can fill in real links later.
- For features planned but not yet designed, mark as "[TODO]" with a brief note.
- TABLE CELLS: The page text shows tables in markdown format (| col1 | col2 |). CRITICAL table rules:
  1. NEVER include pipe characters (|) in "before" or "after" — pipes are column separators, not content.
  2. "before" must contain text from ONE CELL ONLY. Never span multiple columns.
  3. If you need to edit a cell, copy ONLY that cell's text without any | or adjacent cell text.
  Example: For row "| KeywordA | 텍스트A | 설명A |", to edit 텍스트A → 텍스트B:
  ✅ CORRECT: before="텍스트A" after="텍스트B"
  ❌ WRONG: before="KeywordA | 텍스트A" (spans 2 cells)
  ❌ WRONG: before="KeywordA || 텍스트A" (includes pipes)"""

    user_prompt = f"""Page Title: {title}

Page Text:
{table_aware_text[:60000]}

Edit Instruction: {instruction}

Return JSON array (generate up to {len(all_items)} changes — one per instruction item). Each "before" must be a short EXACT substring from the page text above (1 sentence, no newlines):
[{{"id":"change-1","section":"섹션명","description":"간단한 설명","before":"페이지에서 복사한 정확한 짧은 텍스트","after":"대체 텍스트"}}]"""

    log(f"  LLM 호출 중 (Bedrock {BEDROCK_MODEL})...")
    t0 = time.time()

    # Backend /ask 대신 직접 Bedrock 호출
    # Bearer token 방식으로 Bedrock Runtime API 호출
    BEDROCK_MODEL_MAP = {
        "claude-opus-4-6": "global.anthropic.claude-opus-4-6-v1",
        "claude-sonnet-4-6": "global.anthropic.claude-sonnet-4-6",
        "claude-haiku-4-5": "global.anthropic.claude-haiku-4-5-20251001-v1:0",
    }
    model_id = BEDROCK_MODEL_MAP.get(BEDROCK_MODEL, f"global.anthropic.{BEDROCK_MODEL}-v1:0")
    url = f"https://bedrock-runtime.{BEDROCK_REGION}.amazonaws.com/model/{model_id}/invoke"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {BEDROCK_TOKEN}",
    }
    body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 8192,
        "system": system_prompt,
        "messages": [{"role": "user", "content": user_prompt}],
    }

    edit_resp = requests.post(url, headers=headers, json=body, timeout=180)
    elapsed = time.time() - t0

    if not edit_resp.ok:
        log(f"  ❌ Bedrock 호출 실패: {edit_resp.status_code} {edit_resp.text[:200]}")
        return False

    edit_result = edit_resp.json()["content"][0]["text"]
    log(f"  LLM 응답 ({elapsed:.1f}s, {len(edit_result)}자)")

    # JSON 파싱
    try:
        cleaned = re.sub(r"```json\s*", "", edit_result)
        cleaned = re.sub(r"```\s*", "", cleaned).strip()
        json_match = re.search(r"\[[\s\S]*\]", cleaned)
        if not json_match:
            raise ValueError("No JSON array found")
        json_str = json_match.group(0)
        json_str = re.sub(r",\s*([}\]])", r"\1", json_str)  # trailing commas
        changes = json.loads(json_str)
    except Exception as e:
        log(f"  ❌ 수정안 JSON 파싱 실패: {e}")
        log(f"  Raw: {edit_result[:500]}")
        return False

    log(f"  수정안 {len(changes)}건 생성됨")

    # ── Step 5: 검증 ──
    log("Step 5: 수정안 검증")

    pass_count = 0
    fail_count = 0
    cell_merge_count = 0

    for i, change in enumerate(changes):
        cid = change.get("id", f"change-{i+1}")
        before = change.get("before", "")
        after = change.get("after", "")
        desc = change.get("description", "")

        # 검증 1: before가 table-aware text에 존재하는지
        in_text = before in table_aware_text
        if not in_text:
            # 공백 정규화 후 재시도
            normalized_before = re.sub(r"\s+", " ", before).strip()
            normalized_text = re.sub(r"\s+", " ", table_aware_text)
            in_text = normalized_before in normalized_text

        # 검증 2: before가 마크다운 테이블 구분자 패턴( | )을 포함하면 셀 경계 위반
        # 원본 텍스트의 || 등은 허용 (테이블 구분자가 아님)
        has_pipe = bool(re.search(r" \| ", before))  # " | " 패턴만 감지

        # 검증 3: before가 Confluence storage HTML에서 매칭되는지
        before_escaped = escape_html_text(before)
        in_html = before_escaped in storage_html or before in storage_html

        # 검증 4: 셀 병합 감지 — before 텍스트가 여러 <td>에 걸쳐있는지
        # 테이블 행에서 연속된 두 셀의 텍스트가 before에 포함되면 병합으로 판정
        is_cell_merged = False
        for table in tables:
            for row in table.find_all("tr"):
                cells = [c.get_text().strip() for c in row.find_all(["td", "th"])]
                for j in range(len(cells) - 1):
                    if cells[j] and cells[j+1]:
                        # 두 인접 셀의 텍스트가 모두 before에 포함되면 병합
                        if cells[j] in before and cells[j+1] in before and len(cells[j]) > 2 and len(cells[j+1]) > 2:
                            is_cell_merged = True
                            break
                if is_cell_merged:
                    break
            if is_cell_merged:
                break

        status_parts = []
        if in_text:
            status_parts.append("✅ text매칭")
        else:
            status_parts.append("❌ text불일치")
        if in_html:
            status_parts.append("✅ html매칭")
        else:
            status_parts.append("⚠️ html불일치")
        if has_pipe:
            status_parts.append("❌ 파이프포함")
        if is_cell_merged:
            status_parts.append("❌ 셀병합")
            cell_merge_count += 1

        ok = in_text and not has_pipe and not is_cell_merged
        if ok:
            pass_count += 1
        else:
            fail_count += 1

        emoji = "✅" if ok else "❌"
        log(f"  {emoji} [{cid}] {desc[:40]}")
        log(f"     before: \"{before[:60]}\"")
        log(f"     after:  \"{after[:60]}\"")
        log(f"     {' | '.join(status_parts)}")

    # ── Step 6: Confluence HTML 적용 시뮬레이션 ──
    log("Step 6: Confluence 적용 시뮬레이션")
    modified_html = storage_html
    applied = 0
    failed_apply = 0

    for change in changes:
        before = change.get("before", "")
        after = change.get("after", "")
        before_escaped = escape_html_text(before)
        after_escaped = escape_html_text(after)

        if before_escaped in modified_html:
            modified_html = modified_html.replace(before_escaped, after_escaped, 1)
            applied += 1
        elif before in modified_html:
            modified_html = modified_html.replace(before, after, 1)
            applied += 1
        else:
            failed_apply += 1

    log(f"  적용 성공: {applied}/{len(changes)}, 실패: {failed_apply}")

    # ── 결과 요약 ──
    log("")
    log("═══════════════════════════════════════════════")
    log(f"  테이블 수: {len(tables)}")
    log(f"  수정안: {len(changes)}건")
    log(f"  검증 통과: {pass_count}, 실패: {fail_count}")
    log(f"  셀 병합: {cell_merge_count}건")
    log(f"  HTML 적용: {applied}/{len(changes)}")

    all_pass = fail_count == 0 and cell_merge_count == 0
    if all_pass:
        log(f"  ✅ 전체 통과!")
    else:
        log(f"  ❌ {fail_count}건 실패 (셀병합 {cell_merge_count}건)")
    log("═══════════════════════════════════════════════")

    # 결과 저장
    result_path = "/tmp/e2e_edit_suggestion_result.json"
    with open(result_path, "w") as f:
        json.dump({
            "title": title,
            "tables": len(tables),
            "changes": len(changes),
            "pass": pass_count,
            "fail": fail_count,
            "cell_merges": cell_merge_count,
            "html_applied": applied,
            "html_failed": failed_apply,
            "all_pass": all_pass,
        }, f, ensure_ascii=False, indent=2)
    log(f"결과 저장: {result_path}")

    return all_pass


if __name__ == "__main__":
    success = run_test()
    sys.exit(0 if success else 1)
