"""
Google OAuth2 id_token 검증 — Workspace SSO (릴리스-B).

frontend (Klaud desktop) 가 /klaud/log/batch 와 /klaud/report 에 `id_token` (Google
JWT) 을 동봉해서 보냄. backend 가 verify → user_email 을 id_token.email 로
덮어쓰기 (위조 방지). 실패 시 user_email=null (silent fallback, telemetry 는 계속).

설계 메모:
- google-auth 라이브러리의 verify_oauth2_token 이 audience/서명/exp 모두 검증.
- hd (Workspace domain) 는 별도 검증 (id_token claim).
- env 미설정 → SSO 비활성, verify 시도 자체를 skip (모든 id_token 무시).
- counter 는 module-level 변수로 누적 (/klaud/stats 에 노출).
- import 비용 최소화: google.oauth2 / google.auth.transport 는 첫 verify 시점에 lazy.
"""

from __future__ import annotations

import os
import threading
from typing import TypedDict


class GoogleIdTokenClaims(TypedDict, total=False):
    email: str
    email_verified: bool
    hd: str
    sub: str
    name: str
    picture: str
    aud: str
    iss: str
    exp: int


# ── 모듈 상태 (counter, lazy import) ──────────────────────────────────────────

_counter_lock = threading.Lock()
_verify_success_count = 0
_verify_fail_count = 0
_verify_skip_count = 0  # env 미설정으로 skip 한 횟수

_gauth_id_token = None
_gauth_request = None


def _lazy_load() -> tuple[object, object]:
    global _gauth_id_token, _gauth_request
    if _gauth_id_token is None:
        from google.oauth2 import id_token as _gid  # type: ignore[import-not-found]
        from google.auth.transport import requests as _greq  # type: ignore[import-not-found]
        _gauth_id_token = _gid
        _gauth_request = _greq.Request()
    return _gauth_id_token, _gauth_request


# ── env 헬퍼 ──────────────────────────────────────────────────────────────────


def client_id() -> str | None:
    """KLAUD_GOOGLE_CLIENT_ID — 미설정이면 SSO 비활성."""
    v = os.environ.get("KLAUD_GOOGLE_CLIENT_ID", "").strip()
    return v or None


def workspace_domain() -> str | None:
    """KLAUD_GOOGLE_WORKSPACE_DOMAIN — 미설정이면 hd 검증 skip (dev/gmail 허용)."""
    v = os.environ.get("KLAUD_GOOGLE_WORKSPACE_DOMAIN", "").strip()
    return v or None


def admin_emails() -> set[str]:
    """KLAUD_ADMIN_EMAILS — 콤마 구분 set. GET endpoint 의 id_token 경로 게이트.

    case-insensitive 비교 위해 소문자로 정규화. 공백은 strip.
    """
    raw = os.environ.get("KLAUD_ADMIN_EMAILS", "").strip()
    if not raw:
        return set()
    return {e.strip().lower() for e in raw.split(",") if e.strip()}


def sso_enabled() -> bool:
    return client_id() is not None


# ── verify ────────────────────────────────────────────────────────────────────


def verify(token_str: str) -> GoogleIdTokenClaims | None:
    """Google id_token 검증.

    Returns:
        성공: claims dict (email, email_verified, hd, sub 등)
        실패: None (서명/audience/hd/exp/email_verified 어떤 검증이라도 실패)
        SSO 비활성: None (verify 시도 자체 skip, _verify_skip_count 증가)

    counter 는 module-level 누적 — /klaud/stats 에서 조회.
    """
    global _verify_success_count, _verify_fail_count, _verify_skip_count

    cid = client_id()
    if not cid:
        with _counter_lock:
            _verify_skip_count += 1
        return None
    if not token_str:
        with _counter_lock:
            _verify_fail_count += 1
        return None

    try:
        gid, req = _lazy_load()
        # verify_oauth2_token: 서명 (Google JWKS, RS256) + audience + exp 모두 검증
        idinfo = gid.verify_oauth2_token(token_str, req, cid)  # type: ignore[attr-defined]
    except ValueError:
        with _counter_lock:
            _verify_fail_count += 1
        return None
    except Exception:
        # google-auth 가 ValueError 외 다른 예외 (네트워크 등) 던질 수 있음.
        # 운영 안전: telemetry 자체는 계속 — fail count 증가만.
        with _counter_lock:
            _verify_fail_count += 1
        return None

    # hd 검증 (옵션)
    hd_required = workspace_domain()
    if hd_required and idinfo.get("hd") != hd_required:
        with _counter_lock:
            _verify_fail_count += 1
        return None

    # email_verified 강제 — Google 미인증 이메일 거부 (특히 personal Gmail 의 alias)
    if not idinfo.get("email_verified"):
        with _counter_lock:
            _verify_fail_count += 1
        return None

    if not idinfo.get("email"):
        with _counter_lock:
            _verify_fail_count += 1
        return None

    with _counter_lock:
        _verify_success_count += 1
    return idinfo  # type: ignore[return-value]


def is_admin_email(email: str | None) -> bool:
    if not email:
        return False
    return email.strip().lower() in admin_emails()


# ── counters ──────────────────────────────────────────────────────────────────


def stats() -> dict:
    with _counter_lock:
        return {
            "sso_enabled": sso_enabled(),
            "workspace_domain": workspace_domain(),
            "admin_email_count": len(admin_emails()),
            "verify_success_count": _verify_success_count,
            "verify_fail_count": _verify_fail_count,
            "verify_skip_count": _verify_skip_count,
        }


def reset_counters() -> None:
    """테스트 전용."""
    global _verify_success_count, _verify_fail_count, _verify_skip_count
    with _counter_lock:
        _verify_success_count = 0
        _verify_fail_count = 0
        _verify_skip_count = 0
