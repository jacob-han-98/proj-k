"""
remote_db.py - HTTP API를 통한 원격 DB 접근

개발 PC 워커가 서버의 파이프라인 DB에 접근할 때 사용.
db.py와 동일한 인터페이스를 HTTP API로 구현한다.

설정:
    PIPELINE_API_URL=http://서버주소:8088  (환경변수 또는 --remote 옵션)
"""

import json
import logging
import os
from typing import Optional

import requests

log = logging.getLogger("remote_db")

_api_url: str = ""


def configure(api_url: str):
    """API URL 설정."""
    global _api_url
    _api_url = api_url.rstrip("/")
    log.info(f"Remote DB: {_api_url}")


def _url(path: str) -> str:
    return f"{_api_url}/admin/pipeline{path}"


def _get(path: str, params: dict = None) -> dict:
    r = requests.get(_url(path), params=params, timeout=30)
    r.raise_for_status()
    return r.json()


def _post(path: str, params: dict = None, json_body: dict = None) -> dict:
    r = requests.post(_url(path), params=params, json=json_body, timeout=30)
    r.raise_for_status()
    return r.json()


# ── crawl_sources ──

def get_source(source_id: int) -> Optional[dict]:
    try:
        return _get(f"/sources/{source_id}")
    except requests.HTTPError:
        return None


def list_sources() -> list[dict]:
    return _get("/sources").get("sources", [])


# ── documents ──

def upsert_document(source_id: int, file_path: str, file_type: str,
                    file_hash: str = None, file_size: int = None,
                    title: str = None, metadata: dict = None) -> dict:
    """문서 upsert. 반환: {"id": doc_id, "changed": bool, "is_new": bool}"""
    body = {"source_id": source_id, "file_path": file_path, "file_type": file_type}
    if file_hash is not None: body["file_hash"] = file_hash
    if file_size is not None: body["file_size"] = file_size
    if title is not None: body["title"] = title
    if metadata is not None: body["metadata"] = metadata
    result = _post("/documents/upsert", json_body=body)
    return {
        "id": result["document_id"],
        "changed": result.get("changed", True),
        "is_new": result.get("is_new", True),
    }


def get_document(doc_id: int) -> Optional[dict]:
    try:
        data = _get(f"/documents/{doc_id}")
        return data.get("document", data)
    except requests.HTTPError:
        return None


def update_document_status(doc_id: int, status: str):
    _post(f"/documents/{doc_id}/status", params={"status": status})


# ── jobs ──

def claim_job(worker_id: str, worker_types: list[str] = None) -> Optional[dict]:
    types_str = ",".join(worker_types) if worker_types else "any"
    result = _post("/jobs/claim", params={"worker_id": worker_id, "worker_types": types_str})
    return result.get("job")


def start_job(job_id: int):
    _post(f"/jobs/{job_id}/start")


def complete_job(job_id: int, result: dict = None):
    _post(f"/jobs/{job_id}/complete", json_body=result)


def fail_job(job_id: int, error_message: str):
    _post(f"/jobs/{job_id}/fail", params={"error_message": error_message})


# ── conversions ──

def create_conversion(document_id: int, stage: str, strategy: str,
                      input_path: str = None, version: int = None) -> int:
    result = _post("/conversions", json_body={
        "document_id": document_id, "stage": stage, "strategy": strategy,
        "input_path": input_path, "version": version,
    })
    return result["conversion_id"]


def complete_conversion(conv_id: int, output_path: str,
                        quality_score: float = None, stats: dict = None):
    _post(f"/conversions/{conv_id}/complete", json_body={
        "output_path": output_path, "quality_score": quality_score, "stats": stats,
    })


# ── crawl_logs ──

def create_crawl_log(source_id: int, job_id: int = None,
                     crawl_type: str = "full", total_files: int = 0,
                     new_files: int = 0, changed_files: int = 0,
                     unchanged_files: int = 0, deleted_files: int = 0,
                     errors: int = 0, details: dict = None,
                     duration_sec: float = None) -> int:
    result = _post("/crawl-logs", json_body={
        "source_id": source_id, "job_id": job_id, "crawl_type": crawl_type,
        "total_files": total_files, "new_files": new_files,
        "changed_files": changed_files, "unchanged_files": unchanged_files,
        "deleted_files": deleted_files, "errors": errors,
        "details": details, "duration_sec": duration_sec,
    })
    return result.get("log_id", 0)


def update_source_properties(source_id: int, properties: dict):
    _post(f"/sources/{source_id}/properties", json_body=properties)


def get_documents_by_source(source_id: int) -> list[dict]:
    return _get(f"/sources/{source_id}/documents").get("documents", [])


# ── worker heartbeat ──

def worker_heartbeat(worker_id: str, worker_types: list[str], job_types: list[str]):
    _post("/workers/heartbeat", params={
        "worker_id": worker_id,
        "worker_types": ",".join(worker_types),
        "job_types": ",".join(job_types),
    })


# ── pipeline status ──

def get_pipeline_stats() -> dict:
    return _get("/status")


def get_job_stats() -> dict:
    data = _get("/jobs")
    return data.get("stats", {})
