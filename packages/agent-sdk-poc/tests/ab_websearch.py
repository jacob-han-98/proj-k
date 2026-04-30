"""
A/B 테스트 — Tavily REST vs Anthropic Native web_search_20250305

같은 query 3개를 두 backend 로 호출하고 답변 품질·비용·시간 비교.

 - (A) Tavily: search REST → results+answer → Opus 가 종합 답변 작성
 - (B) Native: Anthropic API direct, web_search_20250305 server tool 활성화
       → Claude 가 자동으로 검색 + 답변 + citation 한 번에

실행:
    .venv/bin/python tests/ab_websearch.py

결과 저장: tests/ab_out/<timestamp>_<n>_<label>.json
"""
from __future__ import annotations

import asyncio, json, os, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "ab_out"
OUT.mkdir(exist_ok=True)
sys.path.insert(0, str(HERE.parent / "src"))

# .env 로드 — agent-sdk-poc 우선, gisa fallback (ANTHROPIC_API_KEY 가 거기 있음)
for env_path in [
    HERE.parent / ".env",
    HERE.parent.parent / "qna-poc" / ".env",
    Path("/home/jacob/repos/gisa/.env"),
]:
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                os.environ.setdefault(k.strip(), v.strip())

import httpx
import anthropic

QUERIES = [
    {"id": 1, "label": "bdo_siege",
     "q": "검은사막의 거점전 시작 시간(요일·시각)과 영지 등급별 참여 인원 제한을 구체 수치로 알려줘."},
    {"id": 2, "label": "hit2_voting",
     "q": "HIT2(히트2)의 서버별 버프 투표 또는 조율자의 제단 시스템이 어떻게 작동하는지 설명해줘."},
    {"id": 3, "label": "lineage_w_aden",
     "q": "리니지W 아덴성 공성전(마스터 공성전)의 참여 자격과 보상 구조를 설명해줘."},
]

# ── (A) Tavily backend ──────────────────────────────────────
async def run_tavily(query: str) -> dict:
    api_key = os.environ.get("TAVILY_API_KEY", "")
    if not api_key:
        return {"error": "TAVILY_API_KEY 미설정"}

    t0 = time.time()
    payload = {
        "api_key": api_key, "query": query,
        "search_depth": "basic", "max_results": 5,
        "include_answer": True, "include_raw_content": False,
    }
    try:
        with httpx.Client(timeout=20.0) as c:
            r = c.post("https://api.tavily.com/search", json=payload)
            r.raise_for_status()
            data = r.json()
    except Exception as e:
        return {"error": f"tavily call failed: {e}"}
    search_sec = round(time.time() - t0, 2)

    # Search 결과를 system prompt 로 넣고 Opus 로 답변 합성 (공정 비교 위해)
    results = data.get("results", [])
    snippet = "\n\n".join(
        f"[{i+1}] {r.get('title')}\n  URL: {r.get('url')}\n  {(r.get('content') or '')[:500]}"
        for i, r in enumerate(results[:5])
    )
    sys_prompt = (
        "당신은 게임 기획 분석가입니다. 아래 웹 검색 결과만을 근거로 사용자 질문에 한국어로 답합니다.\n"
        "검색 결과에 없는 내용은 '검색 결과 미확인'으로 명시하고 추측하지 마세요.\n"
        "각 사실 뒤에 (출처: web/<도메인>) 형식으로 인용하세요.\n\n"
        f"--- Tavily 정리 답변 ---\n{data.get('answer','')}\n\n"
        f"--- 검색 결과 ({len(results)}개) ---\n{snippet}"
    )

    t1 = time.time()
    client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY", ""))
    try:
        msg = client.messages.create(
            model="claude-opus-4-5",
            max_tokens=2000,
            system=sys_prompt,
            messages=[{"role": "user", "content": query}],
        )
    except Exception as e:
        return {"error": f"anthropic synth failed: {e}", "search_sec": search_sec}
    synth_sec = round(time.time() - t1, 2)

    answer = "".join(b.text for b in msg.content if hasattr(b, "text"))
    usage = {"input": msg.usage.input_tokens, "output": msg.usage.output_tokens}
    cost = (usage["input"] * 15 + usage["output"] * 75) / 1_000_000  # Opus 가격 (대략)
    return {
        "backend": "tavily+opus",
        "answer": answer,
        "answer_chars": len(answer),
        "search_sec": search_sec,
        "synth_sec": synth_sec,
        "total_sec": round(search_sec + synth_sec, 2),
        "tavily_results_count": len(results),
        "tavily_answer_field": data.get("answer", ""),
        "usage": usage,
        "cost_usd": round(cost, 4),
        "result_urls": [r.get("url") for r in results[:5]],
    }


# ── (B) Anthropic Native web_search_20250305 ───────────────
async def run_native(query: str) -> dict:
    client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY", ""))
    t0 = time.time()
    sys_prompt = (
        "당신은 게임 기획 분석가입니다. 사용자 질문에 한국어로 답합니다.\n"
        "필요하면 web_search 도구로 검색하고, 결과에 없는 내용은 '검색 결과 미확인'으로 명시하세요.\n"
        "각 사실 뒤에 (출처: <인용 정보>) 형식으로 표기하세요."
    )
    try:
        msg = client.messages.create(
            model="claude-opus-4-5",
            max_tokens=2000,
            system=sys_prompt,
            tools=[{"type": "web_search_20250305", "name": "web_search", "max_uses": 5}],
            messages=[{"role": "user", "content": query}],
        )
    except Exception as e:
        return {"error": f"native call failed: {type(e).__name__}: {e}"}
    elapsed = round(time.time() - t0, 2)

    # content 분석 — text 블록 + tool_use + tool_result + citations
    answer_parts = []
    tool_uses = []
    citations = []
    for b in msg.content:
        btype = getattr(b, "type", "")
        if btype == "text":
            answer_parts.append(b.text)
            cs = getattr(b, "citations", None) or []
            for c in cs:
                citations.append({
                    "url": getattr(c, "url", ""),
                    "title": getattr(c, "title", ""),
                    "cited_text": (getattr(c, "cited_text", "") or "")[:200],
                })
        elif btype == "server_tool_use" or btype == "tool_use":
            tool_uses.append({
                "name": getattr(b, "name", ""),
                "input": getattr(b, "input", {}),
            })
        elif btype == "web_search_tool_result":
            # 결과는 답변 작성용, citation 으로 수집됨
            pass

    answer = "".join(answer_parts)
    stu = getattr(msg.usage, "server_tool_use", None)
    stu_dict = None
    if stu is not None:
        # ServerToolUsage 객체를 dict 로 직렬화
        try:
            stu_dict = stu.model_dump() if hasattr(stu, "model_dump") else {
                "web_search_requests": getattr(stu, "web_search_requests", None),
            }
        except Exception:
            stu_dict = str(stu)
    usage = {"input": msg.usage.input_tokens, "output": msg.usage.output_tokens,
             "server_tool_use": stu_dict}
    # Native web_search 비용: $10 / 1000 search + 토큰 비용 별도
    web_search_count = sum(1 for t in tool_uses if t["name"] == "web_search")
    cost_search = web_search_count * 0.01
    cost_tokens = (usage["input"] * 15 + usage["output"] * 75) / 1_000_000
    return {
        "backend": "anthropic-native",
        "answer": answer,
        "answer_chars": len(answer),
        "total_sec": elapsed,
        "tool_uses": tool_uses,
        "web_search_count": web_search_count,
        "citations_count": len(citations),
        "citations": citations[:10],
        "usage": usage,
        "cost_usd": round(cost_search + cost_tokens, 4),
    }


def compare_summary(q: dict, a: dict, b: dict) -> str:
    lines = [f"\n{'='*70}", f"  Query #{q['id']}: {q['q']}", f"{'='*70}"]
    if "error" in a:
        lines.append(f"  Tavily   ❌ {a['error']}")
    else:
        lines.append(f"  Tavily   {a['total_sec']}s  ${a['cost_usd']:.4f}  "
                     f"answer {a['answer_chars']}자  results {a['tavily_results_count']}개")
    if "error" in b:
        lines.append(f"  Native   ❌ {b['error']}")
    else:
        lines.append(f"  Native   {b['total_sec']}s  ${b['cost_usd']:.4f}  "
                     f"answer {b['answer_chars']}자  search {b['web_search_count']}회  "
                     f"citations {b['citations_count']}건")
    return "\n".join(lines)


async def main() -> int:
    print("Anthropic API key:", "set" if os.environ.get("ANTHROPIC_API_KEY") else "NOT set")
    print("Tavily API key:   ", "set" if os.environ.get("TAVILY_API_KEY") else "NOT set")
    if not os.environ.get("ANTHROPIC_API_KEY") or not os.environ.get("TAVILY_API_KEY"):
        return 1

    ts = time.strftime("%Y%m%d_%H%M%S")
    grand_a_cost = 0.0
    grand_b_cost = 0.0

    for q in QUERIES:
        print(f"\n[{q['id']}] {q['label']} 실행 중...")
        a, b = await asyncio.gather(
            run_tavily(q["q"]),
            run_native(q["q"]),
        )
        print(compare_summary(q, a, b))
        if "cost_usd" in a: grand_a_cost += a["cost_usd"]
        if "cost_usd" in b: grand_b_cost += b["cost_usd"]
        # 답변 발췌 출력
        if "answer" in a:
            print(f"\n  --- Tavily 답변 (앞 600자) ---\n  {a['answer'][:600]}")
        if "answer" in b:
            print(f"\n  --- Native 답변 (앞 600자) ---\n  {b['answer'][:600]}")
        # 저장
        path = OUT / f"{ts}_{q['id']}_{q['label']}.json"
        path.write_text(json.dumps({"query": q, "tavily": a, "native": b}, ensure_ascii=False, indent=2))
        print(f"\n  → 저장: {path.name}")

    print(f"\n{'='*70}\n  총 비용: Tavily ${grand_a_cost:.4f}  /  Native ${grand_b_cost:.4f}")
    print(f"  결과 디렉터리: {OUT}\n")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
