"""
test_storage_external.py — storage.py 의 external/ 출처 분기 검증
====================================================================
비교 모드 PoC 의 출처 인용·치환·sanitize 가 깨지지 않는지 확인.

실행:
    .venv/bin/python tests/test_storage_external.py
종료 코드:
    0 = 모두 통과, 1 = 하나라도 실패
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "src"))

from storage import (  # noqa: E402
    _path_to_source_meta,
    extract_sources,
    rewrite_source_paths,
    sanitize_internal_paths,
)


FAILED: list[str] = []


def check(label: str, actual, expected) -> None:
    if actual == expected:
        print(f"  PASS  {label}")
    else:
        FAILED.append(label)
        print(f"  FAIL  {label}\n        actual:   {actual!r}\n        expected: {expected!r}")


def truthy(label: str, value, msg: str = "") -> None:
    if value:
        print(f"  PASS  {label}")
    else:
        FAILED.append(label)
        print(f"  FAIL  {label}  {msg}")


def main() -> int:
    print("\n[1] _path_to_source_meta — external/ 분기")
    meta = _path_to_source_meta("external/리니지M/전투/PVP 시스템 소개")
    check("source", meta["source"], "external")
    check("workbook", meta["workbook"], "리니지M")
    check("sheet", meta["sheet"], "PVP 시스템 소개")
    check("origin_label", meta["origin_label"], "리니지M (참고 자료) / 전투 / PVP 시스템 소개")
    check("origin_url", meta["origin_url"], "")

    print("\n[2] _path_to_source_meta — 한글·공백·영문 혼합 (Lord Nine)")
    meta2 = _path_to_source_meta("external/Lord Nine/CommunityTopic/강화 실패 시스템에 대한 불쾌감")
    check("workbook", meta2["workbook"], "Lord Nine")
    check("source", meta2["source"], "external")
    truthy(
        "origin_label has full chain",
        "강화 실패 시스템에 대한 불쾌감" in meta2["origin_label"],
    )

    print("\n[3] extract_sources — 답변 본문에서 external 출처 추출")
    answer = (
        "PK 의 PVP 는 성향치 기반입니다 (출처: PK_기본 전투 시스템.xlsx / 전투_공식 § 명중 판정).\n"
        "리니지M 도 유사한 패턴 (출처: external/리니지M/전투/성향치 시스템 § 개요).\n"
        "Lord Nine 커뮤니티에서는 강화 실패 불만이 많음 "
        "(출처: external/Lord Nine/CommunityTopic/강화 실패 시스템에 대한 불쾌감 § 토픽 요약)."
    )
    sources = extract_sources(answer)
    check("source count", len(sources), 3)
    ext_sources = [s for s in sources if s["source"] == "external"]
    check("external count", len(ext_sources), 2)
    truthy(
        "리니지M source present",
        any("리니지M" in s["origin_label"] for s in ext_sources),
    )
    truthy(
        "Lord Nine source present",
        any("Lord Nine" in s["origin_label"] for s in ext_sources),
    )
    # xlsx 가 여전히 정상 추출되어야 함 (regression)
    xlsx_sources = [s for s in sources if s["source"] == "xlsx"]
    check("xlsx still classified", len(xlsx_sources), 1)

    print("\n[4] rewrite_source_paths — external/ 토큰이 origin_label 로 치환")
    rewritten = rewrite_source_paths(
        "리니지W 변신은 (출처: external/리니지W/변신 및 마법인형/변신 시스템 § 개요)."
    )
    truthy(
        "external token rewritten to label",
        "리니지W (참고 자료)" in rewritten,
        f"got: {rewritten!r}",
    )
    truthy(
        "raw external/ token gone",
        "external/리니지W/" not in rewritten,
        f"got: {rewritten!r}",
    )

    print("\n[5] sanitize_internal_paths — external/ 는 leak 으로 안 잡힘")
    text = (
        "PK 답변 (출처: external/Vampir/기타/뱀피르_장비 강화 § 일반 설명).\n"
        "내부 경로 노출 예: packages/xlsx-extractor/output/7_System/PK_HUD 시스템/HUD_전투/_final/content.md"
    )
    cleaned, findings = sanitize_internal_paths(text)
    truthy("external left intact", "external/Vampir/기타/뱀피르_장비 강화" in cleaned)
    truthy("packages/ leak detected", any("packages/xlsx-extractor" in f for f in findings))
    truthy(
        "external NOT in findings (no false positive)",
        not any("external/" in f for f in findings),
    )

    print("\n[6] extract_sources — '위와 동일' 축약 (external 도 적용되나)")
    answer_abbrev = (
        "(출처: external/리니지M/전투/PVP 시스템 소개 § 개요).\n"
        "유사 사례 (출처: 위와 동일 § 추가 메카닉)."
    )
    abbrev_sources = extract_sources(answer_abbrev)
    check("abbrev source count", len(abbrev_sources), 2)
    truthy(
        "second source inherits external path",
        all("리니지M" in s["origin_label"] for s in abbrev_sources),
    )

    print("\n[7] _path_to_source_meta — web/ 분기 (Deep Research WebSearch 결과)")
    meta_web = _path_to_source_meta("web/lineagem.plaync.com/PVP 시스템 소개")
    check("source", meta_web["source"], "web")
    check("workbook (domain)", meta_web["workbook"], "lineagem.plaync.com")
    check("sheet (title)", meta_web["sheet"], "PVP 시스템 소개")
    truthy("origin_label has '웹'", "웹" in meta_web["origin_label"])
    check("origin_url", meta_web["origin_url"], "https://lineagem.plaync.com")

    meta_web2 = _path_to_source_meta("web/namu.wiki/HIT2")
    check("namu.wiki domain", meta_web2["workbook"], "namu.wiki")
    truthy("origin_url present", meta_web2["origin_url"].startswith("https://"))

    print("\n[8] sanitize_internal_paths — web/ 도 leak 으로 안 잡힘")
    text_web = (
        "리니지M 공식 페이지 (출처: web/lineagem.plaync.com/PVP 시스템 § 개요).\n"
        "내부 경로: packages/xlsx-extractor/output/A/B/_final/content.md"
    )
    cleaned, findings = sanitize_internal_paths(text_web)
    truthy("web left intact", "web/lineagem.plaync.com" in cleaned)
    truthy("internal leak still detected", any("packages/xlsx" in f for f in findings))
    truthy("web NOT in leak findings", not any("web/" in f for f in findings))

    print("\n[9] extract_sources — 4-tier 출처 혼합 (xlsx + confluence + external + web)")
    mixed = (
        "PK 명중 공식 (출처: PK_기본 전투 시스템.xlsx / 공격&피격 § 1) 명중).\n"
        "Confluence 개선안 (출처: Confluence / 시스템 디자인 / 성장 밸런스 / 명중률 공식 개선 § 개요).\n"
        "리니지M 사례 (출처: external/리니지M/전투/PVP 시스템 소개 § 명중).\n"
        "웹 검색 (출처: web/namu.wiki/리니지M § 전투 공식)."
    )
    mixed_srcs = extract_sources(mixed)
    check("4-tier total", len(mixed_srcs), 4)
    check("xlsx", sum(1 for s in mixed_srcs if s["source"] == "xlsx"), 1)
    check("confluence", sum(1 for s in mixed_srcs if s["source"] == "confluence"), 1)
    check("external", sum(1 for s in mixed_srcs if s["source"] == "external"), 1)
    check("web", sum(1 for s in mixed_srcs if s["source"] == "web"), 1)

    print()
    if FAILED:
        print(f"FAILED: {len(FAILED)} case(s)")
        for f in FAILED:
            print(f"  - {f}")
        return 1
    print("ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
