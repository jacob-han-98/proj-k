"""Confluence Cloud REST API 클라이언트."""

import time
import requests
from urllib.parse import urljoin


class ConfluenceClient:
    """Confluence Cloud REST API v1 클라이언트.

    Basic Auth (email + API token) 방식으로 인증한다.
    """

    def __init__(self, base_url: str, username: str, api_token: str,
                 request_delay: float = 0.3):
        self.base_url = base_url.rstrip("/")
        self.api_url = f"{self.base_url}/rest/api"
        self.session = requests.Session()
        self.session.auth = (username, api_token)
        self.session.headers.update({"Accept": "application/json"})
        self.request_delay = request_delay
        self._request_count = 0
        self._total_time = 0.0

    def _get(self, endpoint: str, params: dict = None,
             _retry_count: int = 0) -> dict:
        """GET 요청 + 레이트 리밋 + 5xx 재시도 + 에러 처리."""
        max_retries = 3
        url = f"{self.api_url}{endpoint}"
        if self._request_count > 0:
            time.sleep(self.request_delay)

        start = time.time()
        resp = self.session.get(url, params=params, timeout=30)
        elapsed = time.time() - start
        self._request_count += 1
        self._total_time += elapsed

        if resp.status_code == 429:
            retry_after = int(resp.headers.get("Retry-After", 5))
            print(f"  [Rate Limit] {retry_after}초 대기 후 재시도...")
            time.sleep(retry_after)
            return self._get(endpoint, params)

        if resp.status_code >= 500 and _retry_count < max_retries:
            wait = 2 ** (_retry_count + 1)  # 2, 4, 8초
            print(f"  [Server {resp.status_code}] {wait}초 대기 후 재시도 ({_retry_count+1}/{max_retries})...")
            time.sleep(wait)
            return self._get(endpoint, params, _retry_count + 1)

        resp.raise_for_status()
        return resp.json()

    def get_page(self, page_id: str, expand: str = "body.storage,version,ancestors") -> dict:
        """페이지 정보 조회 (본문 포함)."""
        return self._get(f"/content/{page_id}", params={"expand": expand})

    def get_children(self, page_id: str, limit: int = 100) -> list:
        """하위 콘텐츠 목록 조회 (page + folder 모두 포함).

        Confluence v1 child/page API는 type:page만 반환하므로,
        CQL `parent = {id}`를 사용하여 page와 folder를 모두 탐색한다.
        """
        all_children = []
        start = 0
        while True:
            data = self._get("/content/search", params={
                "cql": f"parent = {page_id}",
                "limit": limit,
                "start": start,
                "expand": "version",
            })
            results = data.get("results", [])
            all_children.extend(results)
            if len(results) < limit:
                break
            start += limit
        return all_children

    def get_attachments(self, page_id: str, limit: int = 100) -> list:
        """페이지 첨부 파일 목록 조회."""
        all_attachments = []
        start = 0
        while True:
            data = self._get(f"/content/{page_id}/child/attachment", params={
                "limit": limit, "start": start
            })
            results = data.get("results", [])
            all_attachments.extend(results)
            if data.get("size", 0) < limit:
                break
            start += limit
        return all_attachments

    def download_attachment(self, download_path: str) -> bytes:
        """첨부 파일 다운로드. download_path는 attachment._links.download 값."""
        url = f"{self.base_url}{download_path}"
        if self._request_count > 0:
            time.sleep(self.request_delay)

        start = time.time()
        resp = self.session.get(url, timeout=60)
        elapsed = time.time() - start
        self._request_count += 1
        self._total_time += elapsed

        resp.raise_for_status()
        return resp.content

    @property
    def stats(self) -> dict:
        return {
            "request_count": self._request_count,
            "total_time": round(self._total_time, 2),
            "avg_time": round(self._total_time / max(self._request_count, 1), 3),
        }
