#!/usr/bin/env python3
"""기존 Confluence 문서의 HTML 원본 재다운로드 + Markdown 재변환.

이미지는 이미 다운로드되어 있으므로 건드리지 않음.
HTML 본문만 Confluence API에서 다시 받아 content.html로 저장하고,
converter로 content.md를 재생성함.

사용법:
  python redownload_html.py                    # 전체 실행
  python redownload_html.py --dry-run          # 대상만 확인
  python redownload_html.py --limit 5          # 5개만 테스트
  python redownload_html.py --reconvert-only   # API 호출 없이 기존 content.html로 MD만 재생성
"""
import argparse
import importlib.util
import json
import os
import re
import sqlite3
import sys
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[3]
CD_DIR = PROJECT_ROOT / "packages" / "confluence-downloader"

sys.path.insert(0, str(CD_DIR / "src"))

from dotenv import load_dotenv
load_dotenv(CD_DIR / ".env")


def get_client():
    spec = importlib.util.spec_from_file_location("client", str(CD_DIR / "src" / "client.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.ConfluenceClient(
        os.getenv("CONFLUENCE_URL"),
        os.getenv("CONFLUENCE_USERNAME"),
        os.getenv("CONFLUENCE_API_TOKEN"),
        request_delay=0.2,
    )


def get_converter():
    spec = importlib.util.spec_from_file_location("converter", str(CD_DIR / "src" / "converter.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def get_documents():
    """DB에서 Confluence 문서 목록 가져오기."""
    db_path = Path(os.getenv("PIPELINE_DB_PATH", str(Path.home() / ".data-pipeline" / "pipeline.db")))
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT id, file_path, title, metadata FROM documents WHERE source_id = 2"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def html_to_md(converter, html: str, title: str) -> str:
    """HTML → Markdown 변환."""
    if hasattr(converter, 'convert_storage_to_markdown'):
        md, _, _ = converter.convert_storage_to_markdown(html, page_title=title)
        return md
    return f"# {title}\n\n{html}"


def main():
    parser = argparse.ArgumentParser(description="Confluence HTML 재다운로드 + MD 재변환")
    parser.add_argument("--dry-run", action="store_true", help="실행 않고 대상만 표시")
    parser.add_argument("--limit", type=int, default=0, help="처리할 문서 수 제한 (0=전체)")
    parser.add_argument("--reconvert-only", action="store_true", help="API 호출 없이 기존 content.html로 MD만 재생성")
    args = parser.parse_args()

    converter = get_converter()
    docs = get_documents()
    output_dir = CD_DIR / "output"

    print(f"대상 문서: {len(docs)}개")

    if args.limit:
        docs = docs[:args.limit]
        print(f"제한: {args.limit}개만 처리")

    if args.dry_run:
        for d in docs[:10]:
            meta = json.loads(d.get("metadata", "{}") or "{}")
            tree_path = meta.get("tree_path", d.get("title", ""))
            safe_parts = [re.sub(r'[<>:"|?*]', '_', p)[:100] for p in tree_path.split("/")]
            page_dir = output_dir / "/".join(safe_parts)
            has_html = (page_dir / "content.html").exists()
            has_md = (page_dir / "content.md").exists()
            print(f"  {d['title'][:50]:50s} html={'Y' if has_html else 'N'} md={'Y' if has_md else 'N'} dir={page_dir.exists()}")
        if len(docs) > 10:
            print(f"  ... 외 {len(docs) - 10}개")
        return

    client = None if args.reconvert_only else get_client()

    success = 0
    skipped = 0
    errors = 0
    t0 = time.time()

    for i, doc in enumerate(docs):
        title = doc.get("title", "")
        page_id = doc["file_path"]
        meta = json.loads(doc.get("metadata", "{}") or "{}")
        tree_path = meta.get("tree_path", title)
        safe_parts = [re.sub(r'[<>:"|?*]', '_', p)[:100] for p in tree_path.split("/")]
        page_dir = output_dir / "/".join(safe_parts)

        if not page_dir.exists():
            skipped += 1
            continue

        try:
            if args.reconvert_only:
                # 기존 content.html에서 재변환만
                html_path = page_dir / "content.html"
                if not html_path.exists():
                    skipped += 1
                    continue
                body_html = html_path.read_text(encoding="utf-8")
            else:
                # Confluence에서 HTML 다운로드
                page_data = client.get_page(page_id, expand="body.storage")
                body_html = page_data.get("body", {}).get("storage", {}).get("value", "")
                if not body_html:
                    skipped += 1
                    continue
                # content.html 저장
                (page_dir / "content.html").write_text(body_html, encoding="utf-8")

            # Markdown 변환
            markdown = html_to_md(converter, body_html, title)

            # 이미지 참조 검증: images/ 폴더의 실제 파일과 매칭
            images_dir = page_dir / "images"
            if images_dir.exists():
                existing_images = {f.name for f in images_dir.iterdir()
                                   if f.suffix.lower() in ('.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp')}
                # MD에 참조되지 않은 이미지를 본문 끝에 추가
                referenced = set(re.findall(r'!\[[^\]]*\]\(images/([^)]+)\)', markdown))
                missing = existing_images - referenced
                if missing:
                    markdown += "\n\n---\n\n## 추가 이미지\n\n"
                    for img in sorted(missing):
                        markdown += f"![{img}](images/{img})\n\n"

            # content.md 저장
            (page_dir / "content.md").write_text(markdown, encoding="utf-8")
            success += 1

            if (i + 1) % 20 == 0:
                elapsed = time.time() - t0
                rate = (i + 1) / elapsed
                eta = (len(docs) - i - 1) / rate if rate > 0 else 0
                print(f"  [{i+1}/{len(docs)}] {success} OK, {errors} err, {skipped} skip | {elapsed:.0f}s ({rate:.1f}/s, ETA {eta:.0f}s)")

        except Exception as e:
            errors += 1
            print(f"  ERROR [{i+1}] {title[:40]}: {e}")

    elapsed = time.time() - t0
    print(f"\n완료: {success} OK, {errors} err, {skipped} skip ({elapsed:.1f}s)")
    print(f"  content.html + content.md 저장됨")


if __name__ == "__main__":
    main()
