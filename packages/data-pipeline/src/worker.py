"""
worker.py - 작업큐 기반 워커 프레임워크

워커는 DB에서 작업을 가져가서 처리하고 결과를 기록한다.
개발 PC든 서버든 같은 방식으로 동작한다.

DB 접근 모드:
    - local (기본): 직접 SQLite 접근 (서버에서 실행)
    - remote: HTTP API 경유 (개발 PC에서 실행, DB는 서버에)

사용법:
    # 개발 PC — 크롤러+캡처 (서버 DB에 API로 접근)
    python -m src.worker --id win-dev --types crawl,capture --remote http://서버:8088

    # 서버 — 컨버터+인덱서 (로컬 DB 직접 접근)
    python -m src.worker --id linux-srv --types convert,index

    # 단일 작업 실행
    python -m src.worker --id dev --once

    # 특정 소스 크롤링 트리거
    python -m src.worker --trigger crawl --source-id 1
"""

import argparse
import json
import logging
import os
import platform
import signal
import sys
import time
from pathlib import Path
from typing import Callable, Optional

# 프로젝트 경로 설정
PACKAGE_DIR = Path(__file__).parent.parent
PROJECT_ROOT = PACKAGE_DIR.parent.parent
sys.path.insert(0, str(PACKAGE_DIR))

# DB 접근 모듈 — local(직접) 또는 remote(API) 모드
# _db 모듈은 main()에서 모드에 따라 설정됨
_db = None  # src.db (local) 또는 src.remote_db (remote)
_remote_mode = False


def _init_db_module(remote_url: str = None):
    """DB 접근 모듈 초기화."""
    global _db, _remote_mode
    if remote_url:
        from src import remote_db
        remote_db.configure(remote_url)
        _db = remote_db
        _remote_mode = True
        log.info(f"DB 모드: remote ({remote_url})")
    else:
        from src import db as local_db
        local_db.init_db()
        _db = local_db
        _remote_mode = False
        log.info("DB 모드: local (SQLite 직접 접근)")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s %(message)s",
    datefmt="%H:%M:%S"
)
log = logging.getLogger("worker")


# ── 작업 핸들러 레지스트리 ────────────────────────────────

# job_type → handler 함수 매핑
_handlers: dict[str, Callable] = {}


def register_handler(job_type: str):
    """작업 핸들러 데코레이터."""
    def decorator(fn):
        _handlers[job_type] = fn
        return fn
    return decorator


def _safe_dir_parts(tree_path: str, title: str = "") -> list[str]:
    """tree_path를 안전한 디렉토리 parts로 변환.

    제목에 '/'가 포함된 경우 tree_path.split('/')이 잘못 분리되므로,
    제목 부분의 '/'는 '_'로 치환한다.
    """
    import re as _re
    def _sanitize(s):
        return _re.sub(r'[<>:"/\\|?*]', '_', s)[:100]

    if title and '/' in title and tree_path.endswith(title):
        parent = tree_path[:-len(title)].rstrip('/')
        parts = [_sanitize(p) for p in parent.split('/') if p]
        parts.append(_sanitize(title))
        return parts

    return [_sanitize(p) for p in tree_path.split('/')]


# ── 내장 핸들러 ───────────────────────────────────────────

def _db_get_source(source_id: int):
    """DB 모드에 따라 소스 조회."""
    if _remote_mode:
        return _db.get_source(source_id)
    else:
        with _db.get_conn() as conn:
            return _db.get_source(conn, source_id)


def _db_update_source_properties(source_id: int, props: dict):
    """소스의 properties JSON을 업데이트."""
    if _remote_mode:
        pass  # TODO: remote API
    else:
        with _db.get_conn() as conn:
            conn.execute("UPDATE crawl_sources SET properties = ?, updated_at = datetime('now') WHERE id = ?",
                         [json.dumps(props, ensure_ascii=False), source_id])


def _db_upsert_document(source_id, file_path, file_type, **kwargs) -> dict:
    """반환: {"id": doc_id, "changed": bool, "is_new": bool}"""
    if _remote_mode:
        return _db.upsert_document(source_id, file_path, file_type, **kwargs)
    else:
        with _db.get_conn() as conn:
            return _db.upsert_document(conn, source_id, file_path, file_type, **kwargs)


def _db_update_document_status(doc_id, status):
    if _remote_mode:
        _db.update_document_status(doc_id, status)
    else:
        with _db.get_conn() as conn:
            _db.update_document_status(conn, doc_id, status)


def _db_get_document(doc_id):
    if _remote_mode:
        return _db.get_document(doc_id)
    else:
        with _db.get_conn() as conn:
            return _db.get_document(conn, doc_id)


def _db_create_conversion(document_id, stage, strategy, **kwargs):
    if _remote_mode:
        return _db.create_conversion(document_id, stage, strategy, **kwargs)
    else:
        with _db.get_conn() as conn:
            return _db.create_conversion(conn, document_id, stage, strategy, **kwargs)


def _db_complete_conversion(conv_id, output_path, **kwargs):
    if _remote_mode:
        _db.complete_conversion(conv_id, output_path, **kwargs)
    else:
        with _db.get_conn() as conn:
            _db.complete_conversion(conn, conv_id, output_path, **kwargs)


def _db_claim_job(worker_id, worker_types=None):
    if _remote_mode:
        return _db.claim_job(worker_id, worker_types)
    else:
        with _db.get_conn() as conn:
            return _db.claim_job(conn, worker_id, worker_types)


def _db_start_job(job_id):
    if _remote_mode:
        _db.start_job(job_id)
    else:
        with _db.get_conn() as conn:
            _db.start_job(conn, job_id)


def _db_complete_job(job_id, result=None):
    if _remote_mode:
        _db.complete_job(job_id, result)
    else:
        with _db.get_conn() as conn:
            _db.complete_job(conn, job_id, result)


def _db_fail_job(job_id, error_message):
    if _remote_mode:
        _db.fail_job(job_id, error_message)
    else:
        with _db.get_conn() as conn:
            _db.fail_job(conn, job_id, error_message)


def _db_update_job_progress(job_id, progress: str):
    """작업 진행상황 업데이트 (예: '120/498 페이지 처리 중')."""
    if _remote_mode:
        pass  # TODO: remote API
    else:
        with _db.get_conn() as conn:
            conn.execute("UPDATE jobs SET progress = ? WHERE id = ?", [progress, job_id])


def _db_create_job(job_type, **kwargs):
    if _remote_mode:
        # remote에는 create_job이 없으므로 trigger API 사용
        import requests
        params = {"job_type": job_type}
        if kwargs.get("source_id"):
            params["source_id"] = kwargs["source_id"]
        if kwargs.get("document_id"):
            params["document_id"] = kwargs["document_id"]
        r = requests.post(f"{_db._api_url}/admin/pipeline/jobs/trigger", params=params, timeout=10)
        r.raise_for_status()
        return r.json().get("job_id")
    else:
        with _db.get_conn() as conn:
            return _db.create_job(conn, job_type, **kwargs)


def _db_create_crawl_log(source_id, **kwargs):
    if _remote_mode:
        return _db.create_crawl_log(source_id, **kwargs)
    else:
        with _db.get_conn() as conn:
            return _db.create_crawl_log(conn, source_id, **kwargs)


def _db_create_issue(document_id, issue_type, severity, title, description="", reported_by="system"):
    if _remote_mode:
        return _db.create_issue(document_id=document_id, issue_type=issue_type,
                                severity=severity, title=title,
                                description=description, reported_by=reported_by)
    else:
        with _db.get_conn() as conn:
            return _db.create_issue(conn, document_id=document_id, issue_type=issue_type,
                                    severity=severity, title=title,
                                    description=description, reported_by=reported_by)


def _db_update_source_properties(source_id, properties):
    if _remote_mode:
        _db.update_source_properties(source_id, properties)
    else:
        with _db.get_conn() as conn:
            _db.update_source_properties(conn, source_id, properties)


def _db_get_documents_by_source(source_id):
    if _remote_mode:
        return _db.get_documents_by_source(source_id)
    else:
        with _db.get_conn() as conn:
            return _db.get_documents_by_source(conn, source_id)


def _auto_chain_jobs(source: dict, changed_docs: list[dict]):
    """변경된 문서에 대해 다음 파이프라인 단계 작업을 자동 생성. 중복 방지."""
    if not changed_docs:
        return 0

    source_type = source["source_type"]
    next_type = "capture" if source_type == "perforce" else "download"
    created = 0

    # 이미 pending/running인 문서는 스킵
    existing = set()
    if _remote_mode:
        pass
    else:
        with _db.get_conn() as conn:
            rows = conn.execute(
                "SELECT document_id FROM jobs WHERE job_type = ? AND status IN ('pending','running') AND document_id IS NOT NULL",
                [next_type]
            ).fetchall()
            existing = {r["document_id"] for r in rows}

    source_id = source["id"]
    for doc in changed_docs:
        doc_id = doc["id"]
        if doc_id in existing:
            continue
        worker_type = "windows" if source_type == "perforce" else "any"
        _db_create_job(next_type, source_id=source_id, document_id=doc_id,
                       priority=3, worker_type=worker_type)
        created += 1

    if created:
        log.info(f"  자동 체이닝: {created}개 후속 작업 생성 ({source_type})")

    return created


@register_handler("crawl")
def handle_crawl(job: dict, worker_id: str) -> dict:
    """크롤링 작업 처리 — 변경 감지 + 자동 체이닝 + 히스토리 로그."""
    import time as _time
    crawl_start = _time.time()

    params = json.loads(job.get("params", "{}"))
    source_id = job.get("source_id")

    if not source_id:
        raise ValueError("source_id 필요")

    source = _db_get_source(source_id)

    if not source:
        raise ValueError(f"소스 {source_id} 없음")

    source_type = source["source_type"]
    log.info(f"크롤링: {source['name']} ({source_type})")

    job_id = job.get("id")

    if source_type == "perforce":
        result = _crawl_perforce(source, params, job_id=job_id)
    elif source_type == "confluence":
        result = _crawl_confluence(source, params, job_id=job_id)
    else:
        raise ValueError(f"지원하지 않는 소스 타입: {source_type}")

    # B. 자동 파이프라인 체이닝
    changed_docs = result.get("_changed_docs", [])
    chained = _auto_chain_jobs(source, changed_docs)
    result["chained_jobs"] = chained

    # D. 크롤 히스토리 로그
    duration = _time.time() - crawl_start
    _db_create_crawl_log(
        source_id, job_id=job.get("id"),
        crawl_type=params.get("crawl_type", "incremental"),
        total_files=result.get("total_files", 0),
        new_files=result.get("new_files", 0),
        changed_files=result.get("changed_files", 0),
        unchanged_files=result.get("unchanged_files", 0),
        deleted_files=result.get("deleted_files", 0),
        errors=result.get("errors", 0),
        details={
            "changed_list": [d.get("path", "") for d in changed_docs[:100]],
            "p4_changelist": result.get("last_changelist"),
            "confluence_versions": result.get("version_updates"),
        },
        duration_sec=round(duration, 2),
    )
    result.pop("_changed_docs", None)  # 내부용 필드 제거

    log.info(f"크롤링 완료: 전체 {result.get('total_files', 0)}, "
             f"신규 {result.get('new_files', 0)}, "
             f"변경 {result.get('changed_files', 0)}, "
             f"소요 {duration:.1f}초")

    return result


def _crawl_perforce(source: dict, params: dict, job_id: int = None) -> dict:
    """Perforce 크롤링 — changelist 추적 + 해시 변경 감지 + 자동 체이닝."""
    import hashlib
    import subprocess

    props = json.loads(source.get("properties", "{}"))
    depot_path = source["path"]

    # P4 환경변수 로드
    from dotenv import load_dotenv
    load_dotenv(PROJECT_ROOT / "scripts" / ".env")

    p4_env = os.environ.copy()
    for key in ["P4PORT", "P4USER", "P4CLIENT", "P4PASSWD"]:
        val = os.getenv(key)
        if val:
            p4_env[key] = val

    # A-1. 마지막 changelist 확인
    last_cl = props.get("last_changelist")

    # p4 sync
    cmd = ["p4", "sync", depot_path]
    log.info(f"  실행: {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=300, env=p4_env)
    sync_output = (result.stdout + result.stderr).strip()

    # A-2. 최신 changelist 조회
    cl_cmd = ["p4", "changes", "-m1", "-s", "submitted", depot_path]
    cl_result = subprocess.run(cl_cmd, capture_output=True, text=True, timeout=30, env=p4_env)
    new_cl = None
    if cl_result.stdout.strip():
        # "Change 12345 on 2026/03/22 ..." 형식에서 숫자 추출
        parts = cl_result.stdout.strip().split()
        if len(parts) >= 2:
            new_cl = parts[1]

    # 파일 스캔 + 해시 비교
    local_path = props.get("local_path", os.getenv("P4_LOCAL_PATH", ""))
    file_types = props.get("file_types", ["xlsx"])

    new_files = 0
    changed_files = 0
    unchanged_files = 0
    errors = 0
    changed_docs = []
    total = 0

    if local_path:
        base = Path(local_path)
        all_files = [f for ext in file_types for f in base.rglob(f"*.{ext}")]
        total_expected = len(all_files)
        for f in all_files:
                total += 1
                if job_id and total % 10 == 0:
                    _db_update_job_progress(job_id, f"{total}/{total_expected} 파일 스캔 중")
                try:
                    file_hash = hashlib.sha256(f.read_bytes()).hexdigest()
                    rel_path = str(f.relative_to(base))
                    doc_info = _db_upsert_document(
                        source["id"], rel_path, ext,
                        file_hash=file_hash, file_size=f.stat().st_size,
                        title=f.stem
                    )
                    if doc_info["is_new"]:
                        new_files += 1
                        changed_docs.append({"id": doc_info["id"], "path": rel_path})
                        log.info(f"  [NEW] {rel_path}")
                    elif doc_info["changed"]:
                        changed_files += 1
                        changed_docs.append({"id": doc_info["id"], "path": rel_path})
                        log.info(f"  [CHANGED] {rel_path}")
                    else:
                        unchanged_files += 1
                except Exception as e:
                    errors += 1
                    log.error(f"  [ERROR] {f.name}: {e}")

    # A-3. changelist 저장
    if new_cl:
        _db_update_source_properties(source["id"], {"last_changelist": new_cl})

    log.info(f"  P4 결과: 전체 {total}, 신규 {new_files}, 변경 {changed_files}, "
             f"불변 {unchanged_files}, CL {last_cl} → {new_cl}")

    return {
        "total_files": total,
        "new_files": new_files,
        "changed_files": changed_files,
        "unchanged_files": unchanged_files,
        "errors": errors,
        "last_changelist": new_cl,
        "prev_changelist": last_cl,
        "local_path": local_path,
        "_changed_docs": changed_docs,
    }


def _crawl_confluence(source: dict, params: dict, job_id: int = None) -> dict:
    """Confluence 크롤링 — CQL 증분 또는 전체 재귀 탐색 + 버전 비교 + 자동 체이닝."""
    import importlib.util
    import requests as _requests
    cd_dir = PROJECT_ROOT / "packages" / "confluence-downloader"

    from dotenv import load_dotenv
    load_dotenv(cd_dir / ".env")

    # src.client 충돌 방지: importlib로 직접 로드
    spec = importlib.util.spec_from_file_location(
        "confluence_client", str(cd_dir / "src" / "client.py"))
    client_mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(client_mod)
    ConfluenceClient = client_mod.ConfluenceClient

    url = os.getenv("CONFLUENCE_URL")
    username = os.getenv("CONFLUENCE_USERNAME")
    token = os.getenv("CONFLUENCE_API_TOKEN")

    client = ConfluenceClient(url, username, token, request_delay=0.3)

    root_page_id = source["path"]
    props = json.loads(source.get("properties", "{}"))
    max_depth = props.get("max_depth", 10)
    crawl_type = params.get("crawl_type", "incremental")

    # 기존 문서가 없으면 무조건 full crawl
    existing_docs = _db_get_documents_by_source(source["id"])
    if not existing_docs:
        crawl_type = "full"
        log.info("  기존 문서 없음 → full crawl로 전환")

    # A. 페이지 수집 — CQL 증분 또는 전체 재귀
    all_pages = []
    if crawl_type == "incremental":
        # CQL로 마지막 크롤 이후 변경된 페이지만 검색
        last_crawl = props.get("last_crawl_at")
        if not last_crawl:
            crawl_type = "full"
            log.info("  last_crawl_at 없음 → full crawl로 전환")
        else:
            # ISO → Confluence CQL 날짜 형식 (yyyy-MM-dd HH:mm)
            cql_date = last_crawl[:16].replace("T", " ")
            cql = f'ancestor = {root_page_id} AND lastModified > "{cql_date}" ORDER BY lastModified DESC'
            log.info(f"  CQL 증분 크롤: {cql}")

            # CQL 검색 (페이징)
            start = 0
            while True:
                resp = _requests.get(f"{url}/rest/api/content/search", params={
                    "cql": cql, "limit": 200, "start": start,
                    "expand": "version,ancestors"
                }, auth=(username, token))
                if not resp.ok:
                    log.error(f"  CQL 검색 실패: {resp.status_code} {resp.text[:200]}")
                    break
                data = resp.json()
                results = data.get("results", [])
                for p in results:
                    # ancestors에서 depth/parent 추출
                    ancestors = p.get("ancestors", [])
                    p["_depth"] = len(ancestors)
                    p["_parent_id"] = str(ancestors[-1]["id"]) if ancestors else root_page_id
                    all_pages.append(p)
                if len(results) < 200:
                    break
                start += 200

            log.info(f"  CQL 증분 결과: {len(all_pages)}페이지 변경됨")

    if crawl_type == "full":
        _crawl_confluence_recursive(client, root_page_id, all_pages,
                                     depth=0, max_depth=max_depth)
        log.info(f"  전체 탐색 완료: {len(all_pages)}페이지")

    # B. ancestors 경로 빌드 (계층 폴더용)
    page_map = {str(p["id"]): p for p in all_pages}

    # 증분 크롤 시 기존 DB의 tree_path를 fallback으로 사용
    existing_tree_paths = {}
    for doc in existing_docs:
        doc_meta = json.loads(doc.get("metadata", "{}") or "{}")
        if doc_meta.get("tree_path") and "/" in doc_meta["tree_path"]:
            existing_tree_paths[doc["file_path"]] = doc_meta["tree_path"]

    # root_page_id 와 그 상위(스페이스 루트 등)를 모두 제외하기 위한 세트
    # CQL ancestors에는 [스페이스루트, Design루트, 중간카테고리, ...] 순서로 나옴
    # root_page_id (Design) 자체와 그 위의 ancestor는 모두 제외해야 함
    _exclude_ancestor_ids = {root_page_id}
    try:
        resp = _requests.get(f"{url}/rest/api/content/{root_page_id}",
                             params={"expand": "ancestors"}, auth=(username, token))
        if resp.ok:
            for a in resp.json().get("ancestors", []):
                _exclude_ancestor_ids.add(str(a["id"]))
    except Exception:
        pass
    log.info(f"  ancestors 제외 ID: {_exclude_ancestor_ids}")

    def _build_path(page):
        """페이지의 Confluence 트리 경로를 구성 (예: 시스템 디자인/스킬/스킬 강화 시스템)."""
        page_id = str(page["id"])

        # 방법 1: ancestors 필드 활용 (CQL 응답에 포함)
        ancestors = page.get("ancestors", [])
        if ancestors:
            # ancestors는 [스페이스루트, Design루트, ..., direct_parent] 순서
            # root_page와 그 상위 모두 제외
            parts = [a.get("title", "") for a in ancestors if str(a["id"]) not in _exclude_ancestor_ids]
            parts.append(page.get("title", ""))
            if len(parts) > 1:
                return "/".join(parts)

        # 방법 2: page_map에서 부모 타고 올라가기 (full crawl 시)
        parts = [page.get("title", "")]
        parent_id = str(page.get("_parent_id", ""))
        visited = set()
        while parent_id and parent_id in page_map and parent_id not in visited:
            visited.add(parent_id)
            parent = page_map[parent_id]
            parts.insert(0, parent.get("title", ""))
            parent_id = str(parent.get("_parent_id", ""))
        if len(parts) > 1:
            return "/".join(parts)

        # 방법 3: 기존 DB의 tree_path fallback
        if page_id in existing_tree_paths:
            return existing_tree_paths[page_id]

        return page.get("title", "")

    # C. 기존 문서 버전 매핑 (변경 감지용)
    existing_docs = _db_get_documents_by_source(source["id"])
    existing_versions = {}
    for doc in existing_docs:
        meta = json.loads(doc.get("metadata", "{}") or "{}")
        existing_versions[doc["file_path"]] = meta.get("version", 0)
    existing_paths = set(d["file_path"] for d in existing_docs)

    # D. 페이지 등록 + 버전 비교 (다운로드 없이 DB만)
    new_files = 0
    changed_files = 0
    unchanged_files = 0
    errors = 0
    changed_docs = []
    version_updates = []
    crawled_paths = set()

    total_pages = len(all_pages)
    if job_id:
        _db_update_job_progress(job_id, f"0/{total_pages} 페이지 등록 시작")

    for idx, page in enumerate(all_pages, 1):
        page_id = str(page["id"])
        crawled_paths.add(page_id)
        page_version = page.get("version", {}).get("number", 0)
        old_version = existing_versions.get(page_id, 0)
        page_title = page.get("title", "")
        tree_path = _build_path(page)

        if job_id and idx % 50 == 0:
            _db_update_job_progress(job_id, f"{idx}/{total_pages} 페이지 등록 중")

        try:
            version_hash = f"v{page_version}"
            doc_info = _db_upsert_document(
                source["id"], page_id, "html",
                file_hash=version_hash,
                title=page_title,
                metadata={
                    "version": page_version,
                    "depth": page.get("_depth", 0),
                    "parent_id": page.get("_parent_id"),
                    "tree_path": tree_path,
                }
            )

            # CQL 증분: CQL이 반환한 페이지는 lastModified 기준으로 이미 변경 확인됨
            # DB hash와 무관하게 무조건 re-download 대상
            force_changed = (crawl_type == "incremental" and not doc_info["is_new"])

            if doc_info["is_new"]:
                new_files += 1
                changed_docs.append({"id": doc_info["id"], "path": page_id,
                                     "title": page_title})
                log.info(f"  [NEW] {page_title} (v{page_version})")
            elif doc_info["changed"] or force_changed:
                changed_files += 1
                changed_docs.append({"id": doc_info["id"], "path": page_id,
                                     "title": page_title})
                version_updates.append({
                    "page_id": page_id, "title": page_title,
                    "old_version": old_version, "new_version": page_version
                })
                log.info(f"  [CHANGED] {page_title} (v{old_version} → v{page_version})")
            else:
                unchanged_files += 1
        except Exception as e:
            errors += 1
            log.error(f"  [ERROR] {page_title}: {e}")

    # E. 삭제된 페이지 감지 (full crawl 에서만)
    deleted_files = 0
    if crawl_type == "full":
        deleted_paths = existing_paths - crawled_paths
        deleted_files = len(deleted_paths)
        if deleted_paths:
            log.info(f"  삭제 감지: {deleted_files}페이지")

    # F. last_crawl_at 저장 (다음 증분 크롤 기준점)
    from datetime import datetime, timezone
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
    props["last_crawl_at"] = now_iso
    _db_update_source_properties(source["id"], props)

    log.info(f"  Confluence 결과 ({crawl_type}): 전체 {len(all_pages)}, 신규 {new_files}, "
             f"변경 {changed_files}, 불변 {unchanged_files}, 삭제 {deleted_files}")

    return {
        "total_files": len(all_pages),
        "new_files": new_files,
        "changed_files": changed_files,
        "unchanged_files": unchanged_files,
        "deleted_files": deleted_files,
        "errors": errors,
        "crawl_type": crawl_type,
        "version_updates": version_updates,
        "_changed_docs": changed_docs,
    }


def _crawl_confluence_recursive(client, page_id: str, result_list: list,
                                 depth: int = 0, max_depth: int = 10,
                                 parent_id: str = None):
    """Confluence 페이지 트리를 재귀적으로 탐색."""
    if depth > max_depth:
        log.warning(f"  최대 재귀 깊이 초과: depth={depth}, page={page_id}")
        return

    children = client.get_children(page_id, limit=200)
    for child in children:
        child["_depth"] = depth
        child["_parent_id"] = parent_id or page_id
        result_list.append(child)

        # 하위 페이지 재귀 탐색
        child_id = str(child["id"])
        _crawl_confluence_recursive(client, child_id, result_list,
                                     depth=depth + 1, max_depth=max_depth,
                                     parent_id=child_id)

    if depth == 0:
        log.info(f"  재귀 탐색: {len(result_list)}페이지 발견 (최대 깊이: {max_depth})")


def _download_confluence_page(client, converter_mod, page_id: str,
                               title: str, output_dir: Path):
    """변경된 Confluence 페이지의 본문 + 첨부파일 다운로드."""
    import re

    try:
        # 페이지 본문 조회
        page_data = client.get_page(page_id, expand="body.storage,version")
        body_html = page_data.get("body", {}).get("storage", {}).get("value", "")

        if not body_html:
            log.warning(f"    본문 비어있음: {title}")
            return

        # 안전한 폴더명 생성
        safe_title = re.sub(r'[<>:"/\\|?*]', '_', title)[:100]
        page_dir = output_dir / f"{page_id}_{safe_title}"
        page_dir.mkdir(parents=True, exist_ok=True)
        images_dir = page_dir / "images"
        images_dir.mkdir(exist_ok=True)

        # HTML → Markdown 변환
        if converter_mod and hasattr(converter_mod, 'convert_confluence_to_markdown'):
            markdown = converter_mod.convert_confluence_to_markdown(body_html)
        elif converter_mod and hasattr(converter_mod, 'ConfluenceMarkdownConverter'):
            from markdownify import markdownify
            markdown = markdownify(body_html, convert=['ac:image'])
        else:
            # 변환기 없으면 raw HTML 저장
            markdown = body_html

        # content.md 저장
        content_path = page_dir / "content.md"
        content_path.write_text(
            f"# {title}\n\n{markdown}",
            encoding="utf-8"
        )

        # 첨부파일(이미지) 다운로드
        attachments = client.get_attachments(page_id)
        downloaded = 0
        for att in attachments:
            filename = att.get("title", "")
            download_link = att.get("_links", {}).get("download", "")
            if not download_link:
                continue
            # 이미지만 다운로드
            if filename.lower().endswith(('.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp')):
                try:
                    data = client.download_attachment(download_link)
                    (images_dir / filename).write_bytes(data)
                    downloaded += 1
                except Exception as e:
                    log.warning(f"    첨부파일 실패: {filename} — {e}")

        log.info(f"    다운로드: {title} ({len(body_html)}자, 이미지 {downloaded}개)")

    except Exception as e:
        log.error(f"    페이지 다운로드 실패: {title} — {e}")


@register_handler("download")
def handle_download(job: dict, worker_id: str) -> dict:
    """Confluence 페이지 다운로드 — 계층 구조로 본문 + 이미지 저장."""
    import re
    import importlib.util

    document_id = job.get("document_id")
    doc = _db_get_document(document_id)
    source = _db_get_source(doc["source_id"])

    page_id = doc["file_path"]  # Confluence page ID
    title = doc.get("title", "")
    meta = json.loads(doc.get("metadata", "{}") or "{}")
    tree_path = meta.get("tree_path", title)  # 예: "시스템 디자인/스킬/스킬 강화 시스템"

    # tree_path 검증: 빈 문자열이거나 제목만 있으면 crawl 단계에서 경로가 누락된 것
    if not tree_path or tree_path == title:
        log.warning(f"  tree_path 누락 — 제목으로 fallback: {title}")

    log.info(f"다운로드: {title} (page={page_id}, path={tree_path})")

    # Confluence 클라이언트 로드
    cd_dir = PROJECT_ROOT / "packages" / "confluence-downloader"
    from dotenv import load_dotenv
    load_dotenv(cd_dir / ".env")

    spec = importlib.util.spec_from_file_location(
        "confluence_client", str(cd_dir / "src" / "client.py"))
    client_mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(client_mod)
    client = client_mod.ConfluenceClient(
        os.getenv("CONFLUENCE_URL"),
        os.getenv("CONFLUENCE_USERNAME"),
        os.getenv("CONFLUENCE_API_TOKEN"),
        request_delay=0.3,
    )

    # Markdown 변환기 로드
    converter_mod = None
    try:
        conv_spec = importlib.util.spec_from_file_location(
            "confluence_converter", str(cd_dir / "src" / "converter.py"))
        converter_mod = importlib.util.module_from_spec(conv_spec)
        conv_spec.loader.exec_module(converter_mod)
    except Exception:
        pass

    # 페이지 본문 조회
    try:
        page_data = client.get_page(page_id, expand="body.storage,version")
    except Exception as e:
        err = str(e)
        if "403" in err or "401" in err:
            # 권한 없음 → issue 자동 등록
            log.warning(f"  권한 없음: {title} (page={page_id})")
            _db_update_document_status(document_id, "error")
            try:
                _db_create_issue(
                    document_id=document_id,
                    issue_type="access_denied",
                    severity="medium",
                    title=f"Confluence 접근 권한 없음: {title}",
                    description=f"API 토큰으로 page {page_id} 접근 불가. 페이지 권한 조정 또는 API 토큰 권한 확대 필요.",
                    reported_by="system",
                )
            except Exception:
                pass  # 이슈 생성 실패해도 다운로드 실패 처리
            return {"status": "access_denied", "title": title, "error": err[:200]}
        raise

    body_html = page_data.get("body", {}).get("storage", {}).get("value", "")

    if not body_html:
        # 빈 페이지 → placeholder content.md 생성
        log.info(f"  빈 페이지 (본문 없음): {title}")
        output_dir = cd_dir / "output"
        safe_parts = _safe_dir_parts(tree_path, title)
        page_dir = output_dir / "/".join(safe_parts)
        page_dir.mkdir(parents=True, exist_ok=True)
        page_version = page_data.get("version", {}).get("number", 0)
        confluence_url = os.getenv("CONFLUENCE_URL", "").rstrip("/")
        page_link = f"{confluence_url}/wiki/pages/viewpage.action?pageId={page_id}"
        (page_dir / "content.md").write_text(
            f"# {title}\n\n"
            f"> 이 페이지는 Confluence에 본문이 비어있습니다. (v{page_version})\n"
            f"> [Confluence에서 보기]({page_link})\n",
            encoding="utf-8",
        )
        _db_update_document_status(document_id, "downloaded")
        return {"status": "empty", "title": title, "placeholder_created": True}

    # 계층 폴더 생성 (Design/시스템 디자인/스킬/스킬 강화 시스템)
    output_dir = cd_dir / "output"
    safe_parts = _safe_dir_parts(tree_path, title)
    page_dir = output_dir / "/".join(safe_parts)
    page_dir.mkdir(parents=True, exist_ok=True)
    images_dir = page_dir / "images"
    images_dir.mkdir(exist_ok=True)

    # 원본 HTML 저장 (재변환 가능하도록)
    (page_dir / "content.html").write_text(body_html, encoding="utf-8")

    # HTML → Markdown 변환
    if converter_mod and hasattr(converter_mod, 'convert_storage_to_markdown'):
        markdown, image_refs, _ = converter_mod.convert_storage_to_markdown(body_html, page_title=title)
    else:
        markdown = f"# {title}\n\n{body_html}"
        image_refs = []

    # content.md 저장
    content_path = page_dir / "content.md"
    content_path.write_text(markdown, encoding="utf-8")

    # 첨부파일(이미지) 다운로드
    attachments = client.get_attachments(page_id)
    downloaded_images = 0
    for att in attachments:
        filename = att.get("title", "")
        download_link = att.get("_links", {}).get("download", "")
        if not download_link:
            continue
        if filename.lower().endswith(('.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp')):
            try:
                data = client.download_attachment(download_link)
                (images_dir / filename).write_bytes(data)
                downloaded_images += 1
            except Exception as e:
                log.warning(f"    첨부파일 실패: {filename} — {e}")

    log.info(f"  완료: {title} ({len(body_html)}자, 이미지 {downloaded_images}개) → {page_dir}")

    # 문서 상태 업데이트
    _db_update_document_status(document_id, "downloaded")

    # 이미지가 있으면 enrich 작업 체이닝
    if downloaded_images > 0:
        _db_create_job("enrich", source_id=doc["source_id"], document_id=document_id, priority=4, worker_type="any")
        log.info(f"  enrich 작업 체이닝 (이미지 {downloaded_images}개)")

    return {
        "title": title,
        "body_length": len(body_html),
        "images": downloaded_images,
        "output_path": str(page_dir),
    }


@register_handler("enrich")
def handle_enrich(job: dict, worker_id: str) -> dict:
    """Confluence 페이지 이미지 보강 — Opus 4.6 Vision으로 이미지 설명 추가."""
    import importlib.util

    document_id = job.get("document_id")
    doc = _db_get_document(document_id)
    meta = json.loads(doc.get("metadata", "{}") or "{}")
    tree_path = meta.get("tree_path", doc.get("title", ""))

    # enricher 패키지를 sys.path에 추가하여 import 해결
    enricher_dir = PROJECT_ROOT / "packages" / "confluence-enricher"
    from dotenv import load_dotenv
    load_dotenv(enricher_dir / ".env")

    import sys
    enricher_src = str(enricher_dir / "src")
    if enricher_src not in sys.path:
        sys.path.insert(0, enricher_src)

    # src 패키지의 __init__.py가 있으므로 패키지로 로드
    vc_spec = importlib.util.spec_from_file_location(
        "vision_client", str(enricher_dir / "src" / "vision_client.py"))
    vc_mod = importlib.util.module_from_spec(vc_spec)
    vc_spec.loader.exec_module(vc_mod)
    sys.modules["vision_client"] = vc_mod

    spec = importlib.util.spec_from_file_location(
        "enricher", str(enricher_dir / "src" / "enricher.py"),
        submodule_search_locations=[enricher_src])
    enricher_mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(enricher_mod)

    # 페이지 디렉토리 찾기
    cd_dir = PROJECT_ROOT / "packages" / "confluence-downloader"
    output_dir = cd_dir / "output"
    import re
    doc_title = doc.get("title", "")
    safe_parts = _safe_dir_parts(tree_path, doc_title)
    page_dir = output_dir / "/".join(safe_parts)

    if not (page_dir / "content.md").exists():
        raise FileNotFoundError(f"content.md 없음: {page_dir}")

    log.info(f"보강: {doc.get('title', '')} ({page_dir.name})")

    # Opus 4.6으로 모델 오버라이드
    os.environ["VISION_MODEL"] = "claude-opus-4-6"

    # enrich 실행
    result = enricher_mod.enrich_page(page_dir, dry_run=False)

    log.info(f"  보강 완료: 이미지 {result.get('enriched', 0)}/{result.get('total_images', 0)}, "
             f"토큰 {result.get('total_input_tokens', 0)}+{result.get('total_output_tokens', 0)}")

    _db_update_document_status(document_id, "enriched")

    return {
        "title": doc.get("title", ""),
        "enriched_images": result.get("enriched", 0),
        "total_images": result.get("total_images", 0),
        "input_tokens": result.get("total_input_tokens", 0),
        "output_tokens": result.get("total_output_tokens", 0),
    }


@register_handler("capture")
def handle_capture(job: dict, worker_id: str) -> dict:
    """Excel 스크린샷 캡처 (Windows 전용)."""
    if platform.system() != "Windows":
        raise RuntimeError("capture 작업은 Windows에서만 실행 가능")

    # P4 환경변수 로드
    from dotenv import load_dotenv
    load_dotenv(PROJECT_ROOT / "scripts" / ".env")

    params = json.loads(job.get("params", "{}"))
    document_id = job.get("document_id")

    doc = _db_get_document(document_id)
    source = _db_get_source(doc["source_id"])

    # ── 파일 확보: remote 모드 → HTTP 다운로드, local 모드 → 로컬 경로 ──
    _temp_xlsx = None  # cleanup용
    if _remote_mode:
        import tempfile
        tmp_dir = Path(tempfile.gettempdir()) / "pipeline-capture"
        tmp_dir.mkdir(parents=True, exist_ok=True)
        xlsx_path = tmp_dir / Path(doc["file_path"]).name
        _db.download_document_file(document_id, str(xlsx_path))
        _temp_xlsx = xlsx_path
    else:
        props = json.loads(source.get("properties", "{}"))
        local_path = props.get("local_path", "")
        if not local_path:
            raise ValueError("local_path 없음 — 소스 properties 확인")
        xlsx_path = Path(local_path) / doc["file_path"]
        if not xlsx_path.exists():
            raise FileNotFoundError(f"파일 없음: {xlsx_path}")

    # xlsx-extractor capture.py를 subprocess로 실행
    # (importlib 로드 시 ProcessPoolExecutor pickle 충돌 회피)
    import subprocess
    extractor_dir = PROJECT_ROOT / "packages" / "xlsx-extractor"
    capture_script = extractor_dir / "src" / "capture.py"

    # output 경로 결정 — 소스별 서브폴더 분리
    props = json.loads(source.get("properties", "{}"))
    output_subdir = props.get("output_dir", "")
    output_base = extractor_dir / "output"
    if not output_base.is_dir():
        try:
            link_target = output_base.read_text(encoding="utf-8").strip()
            if link_target.startswith("/mnt/"):
                drive = link_target[5]  # /mnt/e → 'e'
                output_base = Path(f"{drive.upper()}:/{link_target[7:]}")
                log.info(f"  심볼릭 링크 → Windows 경로: {output_base}")
        except Exception:
            pass
    if output_subdir:
        output_base = output_base / output_subdir
    output_base.mkdir(parents=True, exist_ok=True)

    import subprocess

    log.info(f"  캡처: {xlsx_path.name} → {output_base}")
    proc = subprocess.run(
        [sys.executable, str(capture_script), str(xlsx_path), str(output_base)],
        capture_output=True, text=True, timeout=600,
        cwd=str(extractor_dir),
    )

    # 결과는 _capture_manifest.json에서 읽기
    safe_name = xlsx_path.stem
    for ch in '/\\:*?"<>|':
        safe_name = safe_name.replace(ch, "_")
    output_dir = output_base / safe_name
    manifest_path = output_dir / "_capture_manifest.json"

    if manifest_path.exists():
        with open(manifest_path, "r", encoding="utf-8") as f:
            manifest = json.load(f)
        sheets = manifest.get("sheets", [])
        ok = sum(1 for s in sheets if s.get("split_success"))
        total = len(sheets)
        stats = {"sheet_count": total, "ok": ok,
                 "failed": total - ok - sum(1 for s in sheets if s.get("blank"))}
    else:
        # 매니페스트조차 없으면 완전 실패
        raise RuntimeError(f"capture.py 실패 (매니페스트 없음): "
                           f"{proc.stderr[-300:] if proc.stderr else proc.stdout[-300:]}")

    # 모든 시트가 성공해야 완료 (일부 실패도 실패 처리 → retry)
    if stats["failed"] > 0:
        raise RuntimeError(f"캡처 실패: {stats['failed']}/{stats['sheet_count']}개 시트 실패")

    # ── remote 모드: 캡처 결과를 zip으로 묶어 서버에 업로드 ──
    if _remote_mode:
        import tempfile
        import zipfile
        zip_path = Path(tempfile.gettempdir()) / f"capture_{document_id}.zip"
        t_zip = time.time()
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for f in output_dir.rglob("*"):
                if f.is_file():
                    arcname = f"{safe_name}/{f.relative_to(output_dir)}"
                    zf.write(f, arcname)
            # _capture_manifest.json도 포함
            if manifest_path.exists():
                zf.write(manifest_path, f"{safe_name}/_capture_manifest.json")
        zip_mb = zip_path.stat().st_size / (1024 * 1024)
        log.info(f"  zip 생성: {zip_mb:.1f}MB ({time.time() - t_zip:.1f}s)")

        t_upload = time.time()
        _db.upload_capture_result(document_id, str(zip_path))
        log.info(f"  업로드 완료 ({time.time() - t_upload:.1f}s)")

        # 업로드 후 로컬 임시파일 정리
        try:
            zip_path.unlink()
            import shutil
            shutil.rmtree(output_dir, ignore_errors=True)
        except Exception:
            pass

    try:
        conv_id = _db_create_conversion(document_id, "capture", "excel-com",
                                         input_path=str(xlsx_path))
        _db_complete_conversion(conv_id, str(output_dir), stats=stats)
    except Exception as e:
        log.warning(f"  변환 이력 기록 실패 (무시): {e}")
    _db_update_document_status(document_id, "captured")

    # remote 모드에서 다운로드한 임시 xlsx 정리
    if _temp_xlsx and _temp_xlsx.exists():
        try:
            _temp_xlsx.unlink()
            log.info(f"  임시 파일 삭제: {_temp_xlsx}")
        except Exception:
            pass

    log.info(f"  캡처 완료: {xlsx_path.name} ({ok}/{stats['sheet_count']} sheets OK)")
    return {"capture_dir": str(output_dir), **stats}


@register_handler("convert")
def handle_convert(job: dict, worker_id: str) -> dict:
    """문서 변환 (Vision AI + OOXML or html-to-md)."""
    params = json.loads(job.get("params", "{}"))
    document_id = job.get("document_id")

    doc = _db_get_document(document_id)
    source = _db_get_source(doc["source_id"])
    strategy = params.get("strategy", source.get("convert_strategy", "vision-first"))

    log.info(f"  변환: {doc['title']} (전략: {strategy})")

    if strategy == "vision-first":
        return _convert_vision_first(doc, source, params)
    elif strategy == "table-parser":
        return _convert_table_parser(doc, source, params)
    elif strategy in ("html-to-md", "image-enrich"):
        return _convert_confluence(doc, source, strategy, params)
    else:
        raise ValueError(f"지원하지 않는 변환 전략: {strategy}")


def _convert_vision_first(doc: dict, source: dict, params: dict) -> dict:
    """Vision-First 변환 — xlsx-extractor 활용."""
    extractor_dir = PROJECT_ROOT / "packages" / "xlsx-extractor"
    sys.path.insert(0, str(extractor_dir))

    props = json.loads(source.get("properties", "{}"))
    local_path = props.get("local_path", os.getenv("P4_LOCAL_PATH", ""))
    xlsx_path = Path(local_path) / doc["file_path"]
    # 소스별 서브폴더 분리 (예: output/7_System/PK_xxx, output/8_Contents/PK_xxx)
    output_subdir = props.get("output_dir", "")
    output_parent = extractor_dir / "output"
    if output_subdir:
        output_parent = output_parent / output_subdir
    output_dir = output_parent / xlsx_path.stem

    conv_id = _db_create_conversion(doc["id"], "synthesize", "vision-first",
                                     input_path=str(xlsx_path))

    import subprocess
    run_py = extractor_dir / "run.py"
    cmd = [sys.executable, str(run_py), str(xlsx_path), "--output", str(output_dir.parent),
           "--stage", "vis-syn"]
    log.info(f"  실행: {' '.join(cmd)}")
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=str(extractor_dir),
                          timeout=600)
    if proc.returncode != 0:
        raise RuntimeError(f"xlsx-extractor 실패 (exit {proc.returncode}): {proc.stderr[-500:]}")
    result = {"stdout_tail": proc.stdout[-300:] if proc.stdout else ""}

    _db_complete_conversion(conv_id, str(output_dir), stats=result or {})
    _db_update_document_status(doc["id"], "converted")

    return {"output_dir": str(output_dir)}


def _convert_table_parser(doc: dict, source: dict, params: dict) -> dict:
    """테이블 파서 변환 — 데이터시트를 SQLite로 인제스트."""
    props = json.loads(source.get("properties", "{}"))
    local_path = props.get("local_path", "")

    if not local_path:
        raise ValueError("table-parser: local_path 속성 필요")

    design_dir = Path(local_path)
    if not design_dir.exists():
        raise FileNotFoundError(f"데이터시트 디렉토리 없음: {design_dir}")

    conv_id = _db_create_conversion(doc["id"], "convert", "table-parser",
                                     input_path=str(design_dir))

    # game_data 모듈로 인제스트
    from src.game_data import ingest_all, get_db_path

    db_path = get_db_path()
    report = ingest_all(str(design_dir), db_path)

    _db_complete_conversion(conv_id, str(db_path), stats=report)
    _db_update_document_status(doc["id"], "converted")

    log.info(f"  table-parser 완료: {report.get('tables_created', 0)}개 테이블, "
             f"{report.get('total_rows', 0)}행, {report.get('db_size_mb', 0)}MB")

    return report


def _convert_confluence(doc: dict, source: dict, strategy: str, params: dict) -> dict:
    """Confluence 변환 (html-to-md + 이미지 보강)."""
    log.info(f"  Confluence 변환: {doc['title']} ({strategy})")

    conv_id = _db_create_conversion(doc["id"], "convert", strategy)

    cd_output = PROJECT_ROOT / "packages" / "confluence-downloader" / "output"
    page_dirs = list(cd_output.rglob(f"*{doc['file_path']}*"))

    if strategy == "image-enrich" and page_dirs:
        enricher_dir = PROJECT_ROOT / "packages" / "confluence-enricher"
        sys.path.insert(0, str(enricher_dir))
        # TODO: 개별 페이지 보강 호출

    _db_complete_conversion(conv_id, str(page_dirs[0]) if page_dirs else "",
                             stats={"strategy": strategy})
    _db_update_document_status(doc["id"], "converted")

    return {"strategy": strategy}


@register_handler("index")
def handle_index(job: dict, worker_id: str) -> dict:
    """ChromaDB 인덱싱."""
    params = json.loads(job.get("params", "{}"))

    qna_dir = PROJECT_ROOT / "packages" / "qna-poc"
    sys.path.insert(0, str(qna_dir))

    log.info("  인덱싱: ChromaDB 재빌드")

    # indexer.py 호출
    from src.indexer import run_indexing
    result = run_indexing(reset=params.get("reset", True))

    # 스냅샷은 로컬 모드에서만 (서버에서 실행)
    if not _remote_mode:
        from src.db import now_iso as _now_iso
        with _db.get_conn() as conn:
            snap_id = _db.create_snapshot(
                conn,
                snapshot_name=f"auto_{_now_iso().replace(':', '').replace('-', '')}",
                chunk_count=result.get("total_chunks", 0),
                document_count=result.get("total_documents", 0),
                chroma_path=str(Path.home() / ".qna-poc-chroma"),
                metadata=result
            )
            _db.activate_snapshot(conn, snap_id)

    return result


# ── 워커 루프 ─────────────────────────────────────────────

class Worker:
    def __init__(self, worker_id: str, worker_types: list[str] = None,
                 poll_interval: int = 3):
        self.worker_id = worker_id
        self.worker_types = worker_types or ["any"]
        self.poll_interval = poll_interval
        self.running = True

    def stop(self, *args):
        log.info("워커 중지 요청")
        self.running = False

    def run_once(self) -> bool:
        """작업 1개 처리. 처리했으면 True."""
        self._heartbeat()
        job = _db_claim_job(self.worker_id, self.worker_types)

        if not job:
            return False

        job_id = job["id"]
        job_type = job["job_type"]
        log.info(f"작업 수령: #{job_id} ({job_type})")

        handler = _handlers.get(job_type)
        if not handler:
            _db_fail_job(job_id, f"핸들러 없음: {job_type}")
            log.error(f"핸들러 없음: {job_type}")
            return True

        _db_start_job(job_id)

        try:
            result = handler(job, self.worker_id)
            _db_complete_job(job_id, result)
            log.info(f"작업 완료: #{job_id}")
        except Exception as e:
            log.error(f"작업 실패: #{job_id} — {e}")
            _db_fail_job(job_id, str(e))

        return True

    def _heartbeat(self):
        """하트비트 전송 — 이 워커가 가동 중임을 DB에 기록."""
        try:
            if _remote_mode:
                _db.worker_heartbeat(self.worker_id, self.worker_types, self.worker_types)
            else:
                with _db.get_conn() as conn:
                    _db.worker_heartbeat(conn, self.worker_id, self.worker_types, self.worker_types)
        except Exception:
            pass  # 하트비트 실패는 무시

    def _cleanup_stale_jobs(self):
        """고아 running 작업 정리 — 워커 kill로 보고 못 한 작업을 pending으로 되돌림."""
        try:
            if _remote_mode:
                import requests
                r = requests.post(
                    f"{_db._api_url}/admin/pipeline/jobs/reset-all",
                    params={"job_type": "capture", "from_status": "running"},
                    timeout=10)
                if r.ok:
                    data = r.json()
                    if data.get("reset", 0) > 0:
                        log.info(f"고아 running 작업 {data['reset']}개 → pending 복원")
                # assigned 상태도 정리
                r2 = requests.post(
                    f"{_db._api_url}/admin/pipeline/jobs/reset-all",
                    params={"job_type": "capture", "from_status": "assigned"},
                    timeout=10)
                if r2.ok:
                    data2 = r2.json()
                    if data2.get("reset", 0) > 0:
                        log.info(f"고아 assigned 작업 {data2['reset']}개 → pending 복원")
            else:
                with _db.get_conn() as conn:
                    for status in ("running", "assigned"):
                        cur = conn.execute(
                            "UPDATE jobs SET status = 'pending', worker_id = NULL "
                            "WHERE job_type IN (?) AND status = ?",
                            [",".join(self.worker_types), status])
                        if cur.rowcount > 0:
                            log.info(f"고아 {status} 작업 {cur.rowcount}개 → pending 복원")
        except Exception as e:
            log.warning(f"고아 작업 정리 실패: {e}")

    def run(self):
        """작업 루프 (Ctrl+C로 중지)."""
        signal.signal(signal.SIGINT, self.stop)
        signal.signal(signal.SIGTERM, self.stop)

        log.info(f"워커 시작: {self.worker_id} (타입: {self.worker_types})")
        log.info(f"폴링 간격: {self.poll_interval}s")

        self._cleanup_stale_jobs()

        # 워커 시작 시 좀비 Excel 정리 (이전 실패로 남은 인스턴스)
        if "capture" in self.worker_types and platform.system() == "Windows":
            import subprocess as _sp
            _sp.run(["taskkill", "/IM", "EXCEL.EXE", "/F"],
                    capture_output=True, timeout=10)
            time.sleep(2)
            log.info("좀비 Excel 정리 완료")

        self._heartbeat()

        while self.running:
            try:
                self._heartbeat()
                had_work = self.run_once()
                if not had_work:
                    time.sleep(self.poll_interval)
            except KeyboardInterrupt:
                break
            except Exception as e:
                log.error(f"루프 오류: {e}")
                time.sleep(self.poll_interval)

        log.info("워커 종료")


# ── CLI ───────────────────────────────────────────────────

def trigger_job(job_type: str, source_id: int = None, document_id: int = None,
                priority: int = 5, worker_type: str = "any",
                params: dict = None):
    """작업을 큐에 등록."""
    job_id = _db_create_job(job_type, source_id=source_id,
                            document_id=document_id, priority=priority,
                            worker_type=worker_type, params=params)
    log.info(f"작업 등록: #{job_id} ({job_type})")
    return job_id


def trigger_full_pipeline(source_id: int):
    """소스에 대해 전체 파이프라인 작업을 등록."""
    source = _db_get_source(source_id)

    if not source:
        log.error(f"소스 {source_id} 없음")
        return

    log.info(f"전체 파이프라인 트리거: {source['name']}")

    crawl_id = trigger_job("crawl", source_id=source_id, priority=1)
    return crawl_id


def main():
    parser = argparse.ArgumentParser(description="데이터 파이프라인 워커")
    parser.add_argument("--id", default=f"{platform.node()}-{os.getpid()}",
                        help="워커 ID")
    parser.add_argument("--types", default="any",
                        help="처리할 작업 타입 (콤마 구분: crawl,capture,convert,index)")
    parser.add_argument("--poll", type=int, default=10,
                        help="폴링 간격 (초)")
    parser.add_argument("--once", action="store_true",
                        help="작업 1개만 처리 후 종료")
    parser.add_argument("--trigger", choices=["crawl", "capture", "convert", "download", "enrich", "index", "full"],
                        help="작업 트리거 (큐에 등록)")
    parser.add_argument("--source-id", type=int, help="소스 ID")
    parser.add_argument("--document-id", type=int, help="문서 ID")
    parser.add_argument("--remote", type=str, default=None,
                        help="원격 API URL (예: http://서버:8088). 지정 시 DB를 API로 접근")
    parser.add_argument("--status", action="store_true", help="작업큐 상태 확인")
    args = parser.parse_args()

    # DB 모드 설정
    remote_url = args.remote or os.getenv("PIPELINE_API_URL")
    _init_db_module(remote_url)

    if args.status:
        if _remote_mode:
            stats = _db.get_job_stats()
        else:
            with _db.get_conn() as conn:
                stats = _db.get_job_stats(conn)
        print("작업큐 상태:")
        for status, count in stats.items():
            print(f"  {status}: {count}")
        return

    if args.trigger:
        if args.trigger == "full":
            if not args.source_id:
                print("ERROR: --source-id 필요")
                return
            trigger_full_pipeline(args.source_id)
        else:
            trigger_job(args.trigger, source_id=args.source_id,
                        document_id=args.document_id)
        return

    worker_types = args.types.split(",")
    worker = Worker(args.id, worker_types, args.poll)

    if args.once:
        worker.run_once()
    else:
        worker.run()


if __name__ == "__main__":
    main()
