"""Confluence 페이지 다운로더.

Confluence Cloud에서 페이지 트리를 재귀적으로 다운로드하여
Markdown + 이미지 구조로 저장한다.

사용법:
    python run.py --dry-run                    # 페이지 트리만 확인
    python run.py                              # 전체 다운로드
    python run.py --page-id 12345              # 특정 페이지부터
    python run.py --max-depth 2                # 깊이 제한
    python run.py --skip-existing              # 이미 변환된 페이지 건너뛰기
"""

import argparse
import io
import json
import os
import re
import sys
import time
from pathlib import Path

# Windows cp949 인코딩 문제 방지
if sys.stdout.encoding != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

from dotenv import load_dotenv

# 프로젝트 루트 기준 import
sys.path.insert(0, str(Path(__file__).parent))
from src.client import ConfluenceClient
from src.converter import convert_storage_to_markdown

# ── 설정 ────────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).parent
OUTPUT_DIR = SCRIPT_DIR / "output"


def sanitize_filename(name: str, max_len: int = 80) -> str:
    """페이지 제목 → 안전한 폴더명.

    한글은 유지하고, 파일시스템에 위험한 문자만 제거한다.
    """
    # 파일시스템 위험 문자 제거
    name = re.sub(r'[<>:"/\\|?*]', '_', name)
    # 앞뒤 공백/점 제거
    name = name.strip(". ")
    # 길이 제한
    if len(name) > max_len:
        name = name[:max_len].rstrip(". ")
    return name or "untitled"


# ── 페이지 트리 구축 ────────────────────────────────────

def build_page_tree(client: ConfluenceClient, page_id: str,
                    max_depth: int = -1, current_depth: int = 0,
                    counter: dict = None) -> dict:
    """페이지 트리를 재귀적으로 구축한다.

    CQL `parent = {id}`를 사용하여 page와 folder 타입 모두 탐색한다.

    Returns:
        {
            "id": "...", "title": "...", "type": "page"|"folder",
            "version": ..., "depth": 0, "children": [...]
        }
    """
    if counter is None:
        counter = {"n": 0}

    page = client.get_page(page_id, expand="version")
    counter["n"] += 1
    content_type = page.get("type", "page")
    node = {
        "id": page["id"],
        "title": page["title"],
        "type": content_type,
        "version": page.get("version", {}).get("number", 0),
        "depth": current_depth,
        "children": [],
    }
    type_label = f"[{content_type}] " if content_type != "page" else ""
    print(f"\r  탐색 중... {counter['n']}개 발견 (현재: {type_label}{page['title'][:40]})", end="", flush=True)

    if max_depth != -1 and current_depth >= max_depth:
        return node

    children = client.get_children(page_id)
    for child in children:
        child_node = build_page_tree(
            client, child["id"], max_depth, current_depth + 1, counter
        )
        node["children"].append(child_node)

    return node


def count_pages(tree: dict) -> int:
    """트리의 총 페이지 수."""
    count = 1
    for child in tree.get("children", []):
        count += count_pages(child)
    return count


def print_tree(tree: dict, indent: str = "", is_last: bool = True, file=None):
    """페이지 트리를 시각적으로 출력."""
    connector = "└── " if is_last else "├── "
    prefix = "" if tree["depth"] == 0 else connector
    type_marker = " [folder]" if tree.get("type") == "folder" else ""
    line = f"{indent}{prefix}{tree['title']} (id:{tree['id']}){type_marker}"
    print(line, file=file)

    if tree["depth"] == 0:
        child_indent = indent
    else:
        child_indent = indent + ("    " if is_last else "│   ")

    children = tree.get("children", [])
    for i, child in enumerate(children):
        print_tree(child, child_indent, i == len(children) - 1, file=file)


def tree_to_markdown(tree: dict, indent: str = "") -> str:
    """페이지 트리를 Markdown 목록으로 변환."""
    lines = []
    bullet = f"{indent}- **{tree['title']}**"
    folder = sanitize_filename(tree["title"])
    if tree["depth"] == 0:
        lines.append(f"# {tree['title']} — 페이지 트리\n")
    else:
        lines.append(bullet)

    for child in tree.get("children", []):
        child_md = tree_to_markdown(child, indent + "  ")
        lines.append(child_md)

    return "\n".join(lines)


# ── 다운로드 & 변환 ─────────────────────────────────────

def resolve_output_path(tree: dict, base_dir: Path, parent_path: Path = None) -> dict:
    """트리의 각 노드에 output 경로를 할당한다."""
    folder_name = sanitize_filename(tree["title"])
    if parent_path is None:
        path = base_dir / folder_name
    else:
        path = parent_path / folder_name
    tree["output_path"] = str(path)

    for child in tree.get("children", []):
        resolve_output_path(child, base_dir, path)
    return tree


def download_page(client: ConfluenceClient, page_id: str, output_path: Path,
                  skip_existing: bool = False, content_type: str = "page") -> dict:
    """단일 페이지를 다운로드하여 Markdown + 이미지 + 영상으로 저장.

    Args:
        content_type: "page" 또는 "folder". folder는 본문이 없을 수 있음.

    Returns:
        {"status": "ok"|"skipped"|"error", "images": int, "videos": int, "size": int, ...}
    """
    content_file = output_path / "content.md"
    if skip_existing and content_file.exists():
        return {"status": "skipped", "images": 0, "videos": 0, "size": 0}

    start = time.time()
    result = {"status": "ok", "images": 0, "videos": 0, "size": 0}

    try:
        # 1) 페이지 본문 가져오기
        page = client.get_page(page_id, expand="body.storage,version")
        title = page["title"]
        storage_html = page.get("body", {}).get("storage", {}).get("value", "")
        version = page.get("version", {}).get("number", 0)
        page_url = page.get("_links", {}).get("webui", "")

        # 2) Storage format → Markdown
        markdown, images_needed, videos_needed = convert_storage_to_markdown(storage_html, title)

        # 3) 프론트매터 추가
        frontmatter = (
            f"---\n"
            f"confluence_id: {page_id}\n"
            f"title: \"{title}\"\n"
            f"version: {version}\n"
            f"source: {client.base_url}{page_url}\n"
            f"downloaded: {time.strftime('%Y-%m-%d %H:%M:%S')}\n"
            f"---\n\n"
        )
        markdown = frontmatter + markdown

        # 4) 디렉토리 생성 & MD 저장
        output_path.mkdir(parents=True, exist_ok=True)
        content_file.write_text(markdown, encoding="utf-8")
        result["size"] = len(markdown.encode("utf-8"))

        # 5) 첨부 파일 목록 가져오기 (이미지+영상 공통)
        attachment_map = {}
        if images_needed or videos_needed:
            attachments = client.get_attachments(page_id)
            for att in attachments:
                att_title = att.get("title", "")
                download_link = att.get("_links", {}).get("download", "")
                if download_link:
                    attachment_map[att_title] = download_link

        # 6) 이미지 다운로드
        if images_needed:
            images_dir = output_path / "images"
            images_dir.mkdir(exist_ok=True)
            for img_filename in images_needed:
                if img_filename in attachment_map:
                    try:
                        img_data = client.download_attachment(attachment_map[img_filename])
                        (images_dir / img_filename).write_bytes(img_data)
                        result["images"] += 1
                    except Exception as e:
                        print(f"    ⚠ 이미지 다운로드 실패: {img_filename} - {e}")

        # 7) 영상 다운로드
        if videos_needed:
            videos_dir = output_path / "videos"
            videos_dir.mkdir(exist_ok=True)
            for vid_filename in videos_needed:
                if vid_filename in attachment_map:
                    try:
                        vid_data = client.download_attachment(attachment_map[vid_filename])
                        (videos_dir / vid_filename).write_bytes(vid_data)
                        result["videos"] += 1
                        vid_mb = len(vid_data) / 1024 / 1024
                        print(f"    📹 영상: {vid_filename} ({vid_mb:.1f}MB)")
                    except Exception as e:
                        print(f"    ⚠ 영상 다운로드 실패: {vid_filename} - {e}")

        result["elapsed"] = round(time.time() - start, 2)

    except Exception as e:
        result["status"] = "error"
        result["error"] = str(e)
        result["elapsed"] = round(time.time() - start, 2)

    return result


def download_tree(client: ConfluenceClient, tree: dict,
                  skip_existing: bool = False,
                  progress: dict = None) -> list:
    """트리 전체를 재귀적으로 다운로드.

    Returns:
        결과 리스트 [{"title": ..., "status": ..., ...}, ...]
    """
    if progress is None:
        progress = {"done": 0, "total": count_pages(tree)}

    output_path = Path(tree["output_path"])
    progress["done"] += 1
    n = progress["done"]
    total = progress["total"]
    pct = int(n / total * 100)

    content_type = tree.get("type", "page")
    type_label = f"[{content_type}] " if content_type != "page" else ""
    print(f"  [{n}/{total} {pct}%] {type_label}{tree['title']}", end="", flush=True)

    result = download_page(client, tree["id"], output_path, skip_existing, content_type)
    result["title"] = tree["title"]
    result["id"] = tree["id"]

    status_icon = {"ok": "✓", "skipped": "→", "error": "✗"}.get(result["status"], "?")
    extra = ""
    if result["status"] == "ok":
        vid_str = f", {result['videos']}vid" if result.get("videos", 0) > 0 else ""
        extra = f" ({result['size']/1024:.1f}KB, {result['images']}img{vid_str}, {result.get('elapsed', 0):.1f}s)"
    elif result["status"] == "error":
        extra = f" ERROR: {result.get('error', '')[:60]}"
    print(f" {status_icon}{extra}")

    results = [result]
    for child in tree.get("children", []):
        results.extend(download_tree(client, child, skip_existing, progress))

    return results


# ── 리포트 ───────────────────────────────────────────────

def print_summary(results: list, client: ConfluenceClient, elapsed: float):
    """다운로드 결과 요약 출력."""
    ok = [r for r in results if r["status"] == "ok"]
    skipped = [r for r in results if r["status"] == "skipped"]
    errors = [r for r in results if r["status"] == "error"]

    total_size = sum(r["size"] for r in ok)
    total_images = sum(r["images"] for r in ok)
    total_videos = sum(r.get("videos", 0) for r in ok)

    print("\n" + "=" * 60)
    print("📊 다운로드 요약")
    print("=" * 60)
    print(f"  총 페이지: {len(results)}")
    print(f"  성공: {len(ok)} | 건너뜀: {len(skipped)} | 실패: {len(errors)}")
    print(f"  총 크기: {total_size/1024:.1f} KB ({total_size/1024/1024:.2f} MB)")
    print(f"  이미지: {total_images}개")
    if total_videos > 0:
        print(f"  영상: {total_videos}개")
    print(f"  소요 시간: {elapsed:.1f}초")
    print(f"  API 요청: {client.stats['request_count']}회 (평균 {client.stats['avg_time']}초)")

    if errors:
        print(f"\n⚠ 실패한 페이지 ({len(errors)}건):")
        for r in errors:
            print(f"  - {r['title']} (id:{r['id']}): {r.get('error', 'unknown')[:80]}")

    print("=" * 60)


# ── 메인 ─────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Confluence → Markdown 다운로더")
    parser.add_argument("--dry-run", action="store_true",
                        help="페이지 트리만 조회하고 다운로드하지 않음")
    parser.add_argument("--page-id", type=str, default=None,
                        help="시작 페이지 ID (기본: .env의 CONFLUENCE_ROOT_PAGE_ID)")
    parser.add_argument("--max-depth", type=int, default=-1,
                        help="최대 탐색 깊이 (-1: 무제한)")
    parser.add_argument("--skip-existing", action="store_true",
                        help="이미 content.md가 있는 페이지 건너뛰기")
    parser.add_argument("--output-dir", type=str, default=None,
                        help="출력 디렉토리 (기본: ./output)")
    parser.add_argument("--delay", type=float, default=0.3,
                        help="API 요청 간 딜레이(초) (기본: 0.3)")
    args = parser.parse_args()

    # .env 로드
    env_path = SCRIPT_DIR / ".env"
    if not env_path.exists():
        print("❌ .env 파일이 없습니다. .env.example을 복사하여 .env를 만들어주세요.")
        sys.exit(1)
    load_dotenv(env_path)

    # 필수 환경변수 확인
    url = os.getenv("CONFLUENCE_URL")
    username = os.getenv("CONFLUENCE_USERNAME")
    token = os.getenv("CONFLUENCE_API_TOKEN")
    root_page_id = args.page_id or os.getenv("CONFLUENCE_ROOT_PAGE_ID")

    missing = []
    if not url:
        missing.append("CONFLUENCE_URL")
    if not username:
        missing.append("CONFLUENCE_USERNAME")
    if not token:
        missing.append("CONFLUENCE_API_TOKEN")
    if not root_page_id:
        missing.append("CONFLUENCE_ROOT_PAGE_ID")
    if missing:
        print(f"❌ 필수 환경변수 누락: {', '.join(missing)}")
        sys.exit(1)

    output_dir = Path(args.output_dir) if args.output_dir else OUTPUT_DIR

    print("=" * 60)
    print("🔄 Confluence 다운로더")
    print("=" * 60)
    print(f"  URL: {url}")
    print(f"  사용자: {username}")
    print(f"  루트 페이지: {root_page_id}")
    print(f"  출력: {output_dir}")
    print(f"  모드: {'DRY-RUN (조회만)' if args.dry_run else '다운로드'}")
    if args.max_depth >= 0:
        print(f"  깊이 제한: {args.max_depth}")
    if args.skip_existing:
        print(f"  기존 파일: 건너뛰기")
    print("=" * 60)

    # 클라이언트 생성
    client = ConfluenceClient(url, username, token, request_delay=args.delay)

    # 1) 페이지 트리 구축
    print("\n📂 페이지 트리 조회 중...")
    start = time.time()
    tree = build_page_tree(client, root_page_id, args.max_depth)
    total_pages = count_pages(tree)
    tree_time = time.time() - start
    print(f"\r  → {total_pages}개 페이지 발견 ({tree_time:.1f}초)" + " " * 40 + "\n")

    # 트리 출력
    print_tree(tree)

    # 트리 정보 저장
    output_dir.mkdir(parents=True, exist_ok=True)
    tree_md = tree_to_markdown(tree)
    (output_dir / "_tree.md").write_text(tree_md, encoding="utf-8")

    # manifest 저장
    resolve_output_path(tree, output_dir)
    manifest = json.dumps(tree, ensure_ascii=False, indent=2)
    (output_dir / "_manifest.json").write_text(manifest, encoding="utf-8")

    if args.dry_run:
        print(f"\n✅ DRY-RUN 완료. {total_pages}개 페이지 확인됨.")
        print(f"  트리 저장: {output_dir / '_tree.md'}")
        print(f"  매니페스트: {output_dir / '_manifest.json'}")
        return

    # 2) 다운로드 실행
    print(f"\n📥 다운로드 시작 ({total_pages}개 페이지)...\n")
    start = time.time()
    results = download_tree(client, tree, args.skip_existing)
    elapsed = time.time() - start

    # 3) 결과 요약
    print_summary(results, client, elapsed)

    # 결과 저장
    results_file = output_dir / "_download_results.json"
    results_json = json.dumps(results, ensure_ascii=False, indent=2)
    results_file.write_text(results_json, encoding="utf-8")
    print(f"\n📄 결과 저장: {results_file}")


if __name__ == "__main__":
    main()
