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


# ── 내장 핸들러 ───────────────────────────────────────────

def _db_get_source(source_id: int):
    """DB 모드에 따라 소스 조회."""
    if _remote_mode:
        return _db.get_source(source_id)
    else:
        with _db.get_conn() as conn:
            return _db.get_source(conn, source_id)


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
    """변경된 문서에 대해 다음 파이프라인 단계 작업을 자동 생성."""
    if not changed_docs:
        return 0

    source_type = source["source_type"]
    created = 0

    for doc in changed_docs:
        doc_id = doc["id"]
        if source_type == "perforce":
            # xlsx → capture (Windows 전용)
            _db_create_job("capture", document_id=doc_id,
                           priority=3, worker_type="windows")
            created += 1
        elif source_type == "confluence":
            # html → convert
            _db_create_job("convert", document_id=doc_id,
                           priority=3, worker_type="any")
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

    if source_type == "perforce":
        result = _crawl_perforce(source, params)
    elif source_type == "confluence":
        result = _crawl_confluence(source, params)
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


def _crawl_perforce(source: dict, params: dict) -> dict:
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
        for ext in file_types:
            for f in base.rglob(f"*.{ext}"):
                total += 1
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


def _crawl_confluence(source: dict, params: dict) -> dict:
    """Confluence 크롤링 — 재귀 탐색 + 버전 비교 + 자동 체이닝."""
    import importlib.util
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
    max_depth = props.get("max_depth", 10)  # 최대 재귀 깊이

    # C. 재귀 크롤링
    all_pages = []
    _crawl_confluence_recursive(client, root_page_id, all_pages,
                                 depth=0, max_depth=max_depth)

    log.info(f"  Confluence 탐색 완료: {len(all_pages)}페이지")

    # 기존 문서 버전 매핑 (변경 감지용)
    existing_docs = _db_get_documents_by_source(source["id"])
    existing_versions = {}
    for doc in existing_docs:
        meta = json.loads(doc.get("metadata", "{}") or "{}")
        existing_versions[doc["file_path"]] = meta.get("version", 0)
    existing_paths = set(d["file_path"] for d in existing_docs)

    # 페이지 등록 + 버전 비교
    new_files = 0
    changed_files = 0
    unchanged_files = 0
    errors = 0
    changed_docs = []
    version_updates = []
    crawled_paths = set()

    for page in all_pages:
        page_id = str(page["id"])
        crawled_paths.add(page_id)
        page_version = page.get("version", {}).get("number", 0)
        old_version = existing_versions.get(page_id, 0)
        page_title = page.get("title", "")

        try:
            # 버전 기반 해시 (Confluence는 파일 해시 없으므로 버전을 해시 대용)
            version_hash = f"v{page_version}"
            doc_info = _db_upsert_document(
                source["id"], page_id, "html",
                file_hash=version_hash,
                title=page_title,
                metadata={
                    "version": page_version,
                    "depth": page.get("_depth", 0),
                    "parent_id": page.get("_parent_id"),
                }
            )
            if doc_info["is_new"]:
                new_files += 1
                changed_docs.append({"id": doc_info["id"], "path": page_id,
                                     "title": page_title})
                log.info(f"  [NEW] {page_title} (v{page_version})")
            elif doc_info["changed"]:
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

    # 삭제된 페이지 감지
    deleted_paths = existing_paths - crawled_paths
    deleted_files = len(deleted_paths)
    if deleted_paths:
        log.info(f"  삭제 감지: {deleted_files}페이지")

    log.info(f"  Confluence 결과: 전체 {len(all_pages)}, 신규 {new_files}, "
             f"변경 {changed_files}, 불변 {unchanged_files}, 삭제 {deleted_files}")

    return {
        "total_files": len(all_pages),
        "new_files": new_files,
        "changed_files": changed_files,
        "unchanged_files": unchanged_files,
        "deleted_files": deleted_files,
        "errors": errors,
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


@register_handler("capture")
def handle_capture(job: dict, worker_id: str) -> dict:
    """Excel 스크린샷 캡처 (Windows 전용)."""
    if platform.system() != "Windows":
        raise RuntimeError("capture 작업은 Windows에서만 실행 가능")

    params = json.loads(job.get("params", "{}"))
    document_id = job.get("document_id")

    doc = _db_get_document(document_id)
    source = _db_get_source(doc["source_id"])
    props = json.loads(source.get("properties", "{}"))
    local_path = props.get("local_path", os.getenv("P4_LOCAL_PATH", ""))

    xlsx_path = Path(local_path) / doc["file_path"]
    if not xlsx_path.exists():
        raise FileNotFoundError(f"파일 없음: {xlsx_path}")

    # xlsx-extractor capture 모듈 활용
    extractor_dir = PROJECT_ROOT / "packages" / "xlsx-extractor"
    sys.path.insert(0, str(extractor_dir))

    from src.capture import capture_workbook
    output_dir = extractor_dir / "output" / xlsx_path.stem
    output_dir.mkdir(parents=True, exist_ok=True)

    log.info(f"  캡처: {xlsx_path.name}")
    result = capture_workbook(str(xlsx_path), str(output_dir))

    conv_id = _db_create_conversion(document_id, "capture", "excel-com",
                                     input_path=str(xlsx_path))
    _db_complete_conversion(conv_id, str(output_dir), stats=result)
    _db_update_document_status(document_id, "captured")

    return {"capture_dir": str(output_dir), "sheets": result.get("sheet_count", 0)}


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
    output_dir = extractor_dir / "output" / xlsx_path.stem

    conv_id = _db_create_conversion(doc["id"], "synthesize", "vision-first",
                                     input_path=str(xlsx_path))

    from run import process_workbook
    result = process_workbook(str(xlsx_path), str(output_dir))

    _db_complete_conversion(conv_id, str(output_dir), stats=result or {})
    _db_update_document_status(doc["id"], "converted")

    return {"output_dir": str(output_dir)}


def _convert_table_parser(doc: dict, source: dict, params: dict) -> dict:
    """테이블 파서 변환 — 수치/테이블 구조 우선."""
    # TODO: 데이터시트용 테이블 파서 구현
    log.warning("table-parser 전략은 아직 구현 중")
    return {"status": "not_implemented"}


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
                 poll_interval: int = 10):
        self.worker_id = worker_id
        self.worker_types = worker_types or ["any"]
        self.poll_interval = poll_interval
        self.running = True

    def stop(self, *args):
        log.info("워커 중지 요청")
        self.running = False

    def run_once(self) -> bool:
        """작업 1개 처리. 처리했으면 True."""
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

    def run(self):
        """작업 루프 (Ctrl+C로 중지)."""
        signal.signal(signal.SIGINT, self.stop)
        signal.signal(signal.SIGTERM, self.stop)

        log.info(f"워커 시작: {self.worker_id} (타입: {self.worker_types})")
        log.info(f"폴링 간격: {self.poll_interval}s")

        while self.running:
            try:
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
    parser.add_argument("--trigger", choices=["crawl", "capture", "convert", "index", "full"],
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
