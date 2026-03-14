#!/usr/bin/env python3
"""
update_sources.py - 데이터 소스 업데이트 통합 명령

사용법:
    python scripts/update_sources.py confluence           # Confluence만 업데이트
    python scripts/update_sources.py perforce             # Perforce만 동기화
    python scripts/update_sources.py all                  # 둘 다
    python scripts/update_sources.py confluence --dry-run  # 변경사항만 확인
"""

import argparse
import io
import json
import os
import sys
import time
from pathlib import Path

# Windows cp949 인코딩 문제 방지
if sys.stdout.encoding != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

PROJECT_ROOT = Path(__file__).parent.parent
SCRIPTS_DIR = Path(__file__).parent

# scripts/.env 로드
from dotenv import load_dotenv
load_dotenv(SCRIPTS_DIR / ".env")


# ── Confluence 업데이트 ──────────────────────────────────

def update_confluence(dry_run: bool = False) -> dict:
    """Confluence에서 변경된 페이지만 업데이트.

    기존 _manifest.json의 version과 원격 version을 비교하여
    변경된 페이지만 재다운로드한다.
    """
    from dotenv import load_dotenv

    cd_dir = PROJECT_ROOT / "packages" / "confluence-downloader"
    sys.path.insert(0, str(cd_dir))

    load_dotenv(cd_dir / ".env")
    from src.client import ConfluenceClient
    from src.converter import convert_storage_to_markdown

    # 기존 downloader의 함수들 import
    # (run.py에서 직접 import 불가하므로 여기서 핵심 로직 재사용)
    from run import (
        build_page_tree, count_pages, resolve_output_path,
        download_page, sanitize_filename
    )

    output_dir = cd_dir / "output"
    manifest_path = output_dir / "_manifest.json"

    # 환경변수 확인
    url = os.getenv("CONFLUENCE_URL")
    username = os.getenv("CONFLUENCE_USERNAME")
    token = os.getenv("CONFLUENCE_API_TOKEN")
    root_page_id = os.getenv("CONFLUENCE_ROOT_PAGE_ID")

    missing = [v for v in ["CONFLUENCE_URL", "CONFLUENCE_USERNAME",
                           "CONFLUENCE_API_TOKEN", "CONFLUENCE_ROOT_PAGE_ID"]
               if not os.getenv(v)]
    if missing:
        print(f"  ERROR: 환경변수 누락: {', '.join(missing)}")
        return {"status": "error", "error": f"missing env: {missing}"}

    client = ConfluenceClient(url, username, token, request_delay=0.3)

    # 1) 로컬 매니페스트에서 버전 정보 로드
    local_versions = {}
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        _extract_versions(manifest, local_versions)
    else:
        print("  WARNING: _manifest.json 없음 — 전체 다운로드 필요")

    # 2) 원격 페이지 트리 조회
    print("  페이지 트리 조회 중...")
    tree = build_page_tree(client, root_page_id)
    total_pages = count_pages(tree)
    print(f"\r  → {total_pages}개 페이지 발견" + " " * 40)

    # 3) 버전 비교
    remote_versions = {}
    _extract_versions(tree, remote_versions)

    changed = []
    new_pages = []
    for page_id, info in remote_versions.items():
        local_ver = local_versions.get(page_id, {}).get("version", 0)
        if page_id not in local_versions:
            new_pages.append(info)
        elif info["version"] > local_ver:
            changed.append({**info, "local_version": local_ver})

    print(f"\n  변경 감지 결과:")
    print(f"    변경됨: {len(changed)}개")
    print(f"    신규: {len(new_pages)}개")
    print(f"    변경 없음: {total_pages - len(changed) - len(new_pages)}개")

    if changed:
        print(f"\n  변경된 페이지:")
        for p in changed[:20]:
            print(f"    - {p['title']} (v{p['local_version']} → v{p['version']})")
        if len(changed) > 20:
            print(f"    ... 외 {len(changed) - 20}개")

    if new_pages:
        print(f"\n  신규 페이지:")
        for p in new_pages[:10]:
            print(f"    - {p['title']}")
        if len(new_pages) > 10:
            print(f"    ... 외 {len(new_pages) - 10}개")

    if dry_run:
        return {
            "status": "dry_run",
            "total": total_pages,
            "changed": len(changed),
            "new": len(new_pages),
        }

    # 4) 변경된 페이지만 재다운로드
    to_download = changed + new_pages
    if not to_download:
        print("\n  업데이트할 페이지 없음.")
        return {"status": "no_changes", "total": total_pages}

    resolve_output_path(tree, output_dir)

    print(f"\n  {len(to_download)}개 페이지 다운로드 시작...")
    results = []
    for i, page_info in enumerate(to_download):
        # 트리에서 해당 노드의 output_path 찾기
        node = _find_node(tree, page_info["id"])
        if not node or "output_path" not in node:
            print(f"    [{i+1}/{len(to_download)}] {page_info['title']} — SKIP (경로 없음)")
            continue

        output_path = Path(node["output_path"])
        content_type = node.get("type", "page")
        print(f"    [{i+1}/{len(to_download)}] {page_info['title']}", end="", flush=True)

        result = download_page(client, page_info["id"], output_path,
                               skip_existing=False, content_type=content_type)
        result["title"] = page_info["title"]
        results.append(result)

        status_icon = {"ok": "✓", "error": "✗"}.get(result["status"], "?")
        print(f" {status_icon}")

    # 5) 매니페스트 업데이트
    resolve_output_path(tree, output_dir)
    manifest_json = json.dumps(tree, ensure_ascii=False, indent=2)
    manifest_path.write_text(manifest_json, encoding="utf-8")

    ok_count = sum(1 for r in results if r["status"] == "ok")
    return {
        "status": "updated",
        "total": total_pages,
        "downloaded": ok_count,
        "changed": len(changed),
        "new": len(new_pages),
        "updated_pages": [r["title"] for r in results if r["status"] == "ok"],
    }


def _extract_versions(tree: dict, versions: dict):
    """트리에서 {page_id: {title, version}} 맵 추출."""
    versions[tree["id"]] = {
        "id": tree["id"],
        "title": tree["title"],
        "version": tree.get("version", 0),
    }
    for child in tree.get("children", []):
        _extract_versions(child, versions)


def _find_node(tree: dict, page_id: str) -> dict | None:
    """트리에서 page_id로 노드 찾기."""
    if tree["id"] == page_id:
        return tree
    for child in tree.get("children", []):
        found = _find_node(child, page_id)
        if found:
            return found
    return None


# ── Perforce 동기화 ──────────────────────────────────────

def update_perforce(dry_run: bool = False) -> dict:
    """Perforce에서 파일 동기화.

    scripts/.env의 P4 설정을 사용한다.
    P4_LOCAL_PATH가 설정되면 프로젝트 외부 경로로도 동기화 가능.
    """
    import subprocess

    # P4 환경변수 확인
    p4port = os.getenv("P4PORT")
    p4user = os.getenv("P4USER")
    p4client = os.getenv("P4CLIENT")
    p4_depot_path = os.getenv("P4_DEPOT_PATH")
    p4_local_path = os.getenv("P4_LOCAL_PATH")

    if not p4port or not p4user or not p4client:
        missing = [v for v in ["P4PORT", "P4USER", "P4CLIENT"]
                   if not os.getenv(v)]
        print(f"  ERROR: P4 환경변수 미설정: {', '.join(missing)}")
        print(f"  scripts/.env 파일에 P4 설정을 추가하세요.")
        print(f"  참고: scripts/.env.example")
        return {"status": "error", "error": f"missing env: {missing}"}

    # P4 환경변수를 subprocess 환경에 전달
    p4_env = os.environ.copy()
    p4_env["P4PORT"] = p4port
    p4_env["P4USER"] = p4user
    p4_env["P4CLIENT"] = p4client
    p4passwd = os.getenv("P4PASSWD")
    if p4passwd:
        p4_env["P4PASSWD"] = p4passwd

    # P4 연결 확인
    try:
        result = subprocess.run(
            ["p4", "info"], capture_output=True, text=True,
            timeout=10, env=p4_env
        )
        if result.returncode != 0:
            print(f"  ERROR: p4 info 실패: {result.stderr.strip()}")
            return {"status": "error", "error": "p4 info failed"}
        # 연결 정보 출력
        for line in result.stdout.strip().split("\n")[:5]:
            print(f"    {line.strip()}")
    except FileNotFoundError:
        print("  ERROR: p4 CLI가 설치되어 있지 않습니다.")
        print("  https://www.perforce.com/downloads/helix-command-line-client-p4 에서 설치하세요.")
        return {"status": "error", "error": "p4 not found"}
    except subprocess.TimeoutExpired:
        print("  ERROR: p4 info 타임아웃 — 서버 연결을 확인하세요.")
        return {"status": "error", "error": "p4 timeout"}

    # 동기화 대상 결정
    if p4_depot_path:
        sync_target = p4_depot_path
    elif p4_local_path:
        sync_target = str(Path(p4_local_path) / "...")
    else:
        print("  ERROR: P4_DEPOT_PATH 또는 P4_LOCAL_PATH를 설정하세요.")
        return {"status": "error", "error": "no sync target"}

    # p4 sync 실행
    cmd = ["p4", "sync"]
    if dry_run:
        cmd.append("-n")  # preview mode
    cmd.append(sync_target)

    print(f"\n  실행: {' '.join(cmd)}")
    result = subprocess.run(
        cmd, capture_output=True, text=True,
        timeout=300, env=p4_env
    )

    if result.returncode != 0 and result.stderr:
        print(f"  p4 sync 출력: {result.stderr.strip()}")

    # 결과 파싱
    output = (result.stdout + result.stderr).strip()
    lines = output.split("\n") if output else []
    updated_files = [l for l in lines
                     if l.strip() and ("updating" in l.lower() or "added" in l.lower())]

    xlsx_files = [l for l in updated_files if ".xlsx" in l.lower()]
    print(f"\n  동기화 결과:")
    print(f"    대상 경로: {p4_local_path or '(워크스페이스 기본)'}")
    print(f"    변경 파일: {len(updated_files)}개")
    print(f"    XLSX 파일: {len(xlsx_files)}개")

    if xlsx_files and len(xlsx_files) <= 20:
        for f in xlsx_files:
            print(f"    - {f.strip()}")
    elif len(xlsx_files) > 20:
        for f in xlsx_files[:20]:
            print(f"    - {f.strip()}")
        print(f"    ... 외 {len(xlsx_files) - 20}개")

    # 변경된 xlsx 파일 목록 저장 (증분 변환용)
    if xlsx_files:
        changed_list_path = SCRIPTS_DIR / "last_p4_changed_xlsx.json"
        changed_data = {
            "synced_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "local_path": p4_local_path or "",
            "xlsx_files": [l.strip() for l in xlsx_files],
        }
        changed_list_path.write_text(
            json.dumps(changed_data, ensure_ascii=False, indent=2),
            encoding="utf-8"
        )

    return {
        "status": "dry_run" if dry_run else "synced",
        "local_path": p4_local_path or "",
        "total_files": len(updated_files),
        "xlsx_files": len(xlsx_files),
        "xlsx_list": [l.strip() for l in xlsx_files],
    }


# ── 메인 ─────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="데이터 소스 업데이트")
    parser.add_argument("source", choices=["confluence", "perforce", "all"],
                        help="업데이트할 소스")
    parser.add_argument("--dry-run", action="store_true",
                        help="변경사항만 확인 (실제 다운로드 없음)")
    args = parser.parse_args()

    print("=" * 60)
    print(f"데이터 소스 업데이트 {'(DRY RUN)' if args.dry_run else ''}")
    print("=" * 60)

    results = {}
    start = time.time()

    if args.source in ("confluence", "all"):
        print(f"\n[Confluence]")
        results["confluence"] = update_confluence(dry_run=args.dry_run)

    if args.source in ("perforce", "all"):
        print(f"\n[Perforce]")
        results["perforce"] = update_perforce(dry_run=args.dry_run)

    elapsed = round(time.time() - start, 1)
    print(f"\n{'=' * 60}")
    print(f"완료 ({elapsed}s)")
    for source, result in results.items():
        print(f"  {source}: {result.get('status', 'unknown')}")
    print("=" * 60)

    # 결과 저장
    results_path = PROJECT_ROOT / "scripts" / "last_update_results.json"
    results_path.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")

    return results


if __name__ == "__main__":
    main()
