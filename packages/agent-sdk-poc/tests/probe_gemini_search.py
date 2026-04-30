"""Gemini google_search grounding 빠른 smoke."""
from __future__ import annotations
import os, sys, time
from pathlib import Path

# .env 로드 (gemini key 가 insight 에 있음)
for env_path in [
    Path("/home/jacob/repos/proj-k/packages/agent-sdk-poc/.env"),
    Path("/home/jacob/repos/insight/.env"),
    Path("/home/jacob/repos/oracle/.env"),
]:
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                os.environ.setdefault(k.strip(), v.strip())

from google import genai
from google.genai import types

key = os.environ.get("GEMINI_API_KEY", "")
print(f"GEMINI_API_KEY: {'set' if key else 'NOT set'}")
if not key:
    sys.exit(1)

client = genai.Client(api_key=key)

query = "검은사막 거점전 시작 시간(요일·시각)과 영지 등급별 인원 제한"
print(f"\nquery: {query}\n")

t0 = time.time()
resp = client.models.generate_content(
    model="gemini-2.5-flash",  # 빠르고 저렴
    contents=query,
    config=types.GenerateContentConfig(
        tools=[types.Tool(google_search=types.GoogleSearch())],
        temperature=0.2,
    ),
)
elapsed = time.time() - t0

print(f"=== answer ({elapsed:.1f}s) ===")
print(resp.text[:1500])

# grounding metadata
gm = resp.candidates[0].grounding_metadata if resp.candidates else None
if gm:
    queries = getattr(gm, "web_search_queries", []) or []
    chunks = getattr(gm, "grounding_chunks", []) or []
    supports = getattr(gm, "grounding_supports", []) or []
    print(f"\n=== grounding ===")
    print(f"  web_search_queries ({len(queries)}): {queries[:5]}")
    print(f"  grounding_chunks: {len(chunks)}")
    for c in chunks[:5]:
        web = getattr(c, "web", None)
        if web:
            print(f"    - {getattr(web, 'title', '')[:60]} | {getattr(web, 'uri', '')[:80]}")
    print(f"  grounding_supports: {len(supports)} (citation spans)")
else:
    print("\n(no grounding_metadata)")

# 토큰/usage
um = getattr(resp, "usage_metadata", None)
if um:
    print(f"\n=== usage ===")
    print(f"  prompt_token_count: {getattr(um, 'prompt_token_count', '?')}")
    print(f"  candidates_token_count: {getattr(um, 'candidates_token_count', '?')}")
    print(f"  total_token_count: {getattr(um, 'total_token_count', '?')}")
