"""
indexer.py — content.md 파일들을 청킹 → 임베딩 → ChromaDB 저장

Usage:
    python -m src.indexer                           # 전체 인덱싱
    python -m src.indexer --workbook "PK_변신 및 스킬 시스템"  # 단일 파일
    python -m src.indexer --stats                   # 통계만 출력
"""

import json
import os
import re
import sys
import time
from pathlib import Path

import chromadb
import requests
from dotenv import load_dotenv

# ── 설정 ──

EXTRACTOR_OUTPUT = Path(__file__).resolve().parent.parent.parent / "xlsx-extractor" / "output"
CHROMA_DIR = Path.home() / ".qna-poc-chroma"
COLLECTION_NAME = "project_k"

MAX_CHUNK_TOKENS = 2000  # 청크 최대 토큰 (대략 1000 한글 글자)
MIN_CHUNK_TOKENS = 100   # 너무 작은 청크 방지
APPROX_TOKENS_PER_CHAR = 0.5  # 한국어 대략 추정 (실제는 ~0.4-0.6)

load_dotenv(Path(__file__).resolve().parent.parent / ".env")


# ── 청킹 ──

def estimate_tokens(text: str) -> int:
    """한국어/영어 혼합 텍스트의 토큰 수 대략 추정."""
    return max(1, int(len(text) * APPROX_TOKENS_PER_CHAR))


def parse_content_md(filepath: Path) -> dict:
    """content.md 파일에서 메타데이터와 섹션을 추출."""
    text = filepath.read_text(encoding="utf-8")
    lines = text.split("\n")

    # 메타데이터 추출 (첫 몇 줄의 blockquote)
    workbook = ""
    sheet = ""
    for line in lines[:10]:
        if line.startswith("> 원본:"):
            parts = line.replace("> 원본:", "").strip().split(" / 시트: ")
            workbook = parts[0].strip()
            sheet = parts[1].strip() if len(parts) > 1 else ""
            break

    # H1 제목 추출
    h1_title = ""
    for line in lines:
        if line.startswith("# ") and not line.startswith("## "):
            h1_title = line[2:].strip()
            break

    # 섹션 분할 (H2 기준)
    sections = []
    current_heading = h1_title or sheet
    current_lines = []
    heading_level = 1

    # 메타데이터 블록(--- 구분선 이전) 건너뛰기
    content_start = 0
    hr_count = 0
    for i, line in enumerate(lines):
        if line.strip() == "---":
            hr_count += 1
            if hr_count >= 2:  # 두 번째 --- 이후가 본문
                content_start = i + 1
                break

    for line in lines[content_start:]:
        # H2 헤딩 감지
        if line.startswith("## ") and not line.startswith("### "):
            # 이전 섹션 저장
            if current_lines:
                section_text = "\n".join(current_lines).strip()
                if section_text:
                    sections.append({
                        "heading": current_heading,
                        "level": heading_level,
                        "text": section_text,
                    })
            current_heading = line[3:].strip()
            heading_level = 2
            current_lines = []
        else:
            current_lines.append(line)

    # 마지막 섹션
    if current_lines:
        section_text = "\n".join(current_lines).strip()
        if section_text:
            sections.append({
                "heading": current_heading,
                "level": heading_level,
                "text": section_text,
            })

    return {
        "workbook": workbook,
        "sheet": sheet,
        "h1_title": h1_title,
        "sections": sections,
        "filepath": str(filepath),
    }


def chunk_section(section: dict, parent_context: str, max_tokens: int = MAX_CHUNK_TOKENS) -> list[dict]:
    """단일 섹션을 토큰 제한에 맞게 청크로 분할.

    Mermaid 블록은 절대 분할하지 않는다.
    """
    text = section["text"]
    heading = section["heading"]
    prefix = f"[{parent_context}]\n## {heading}\n\n" if parent_context else f"## {heading}\n\n"

    tokens = estimate_tokens(prefix + text)

    # 토큰 제한 이내면 그대로 반환
    if tokens <= max_tokens:
        return [{
            "heading": heading,
            "text": prefix + text,
            "tokens": tokens,
        }]

    # H3 기준으로 하위 분할
    chunks = []
    h3_parts = re.split(r'(?=^### )', text, flags=re.MULTILINE)

    current_chunk_lines = []
    current_chunk_heading = heading

    for part in h3_parts:
        part = part.strip()
        if not part:
            continue

        # H3 제목 추출
        h3_match = re.match(r'^### (.+)', part)
        sub_heading = h3_match.group(1).strip() if h3_match else ""

        part_with_prefix = prefix + part if not current_chunk_lines else part
        part_tokens = estimate_tokens(part_with_prefix)

        if current_chunk_lines:
            combined = "\n\n".join(current_chunk_lines + [part])
            combined_tokens = estimate_tokens(prefix + combined)

            if combined_tokens <= max_tokens:
                current_chunk_lines.append(part)
                continue

            # 현재 청크 저장
            chunk_text = prefix + "\n\n".join(current_chunk_lines)
            chunks.append({
                "heading": current_chunk_heading,
                "text": chunk_text,
                "tokens": estimate_tokens(chunk_text),
            })
            current_chunk_lines = [part]
            current_chunk_heading = f"{heading} > {sub_heading}" if sub_heading else heading
        else:
            current_chunk_lines = [part]
            current_chunk_heading = f"{heading} > {sub_heading}" if sub_heading else heading

    # 마지막 청크
    if current_chunk_lines:
        chunk_text = prefix + "\n\n".join(current_chunk_lines)
        chunks.append({
            "heading": current_chunk_heading,
            "text": chunk_text,
            "tokens": estimate_tokens(chunk_text),
        })

    return chunks if chunks else [{"heading": heading, "text": prefix + text, "tokens": tokens}]


def chunk_file(filepath: Path) -> list[dict]:
    """content.md 파일 하나를 청크 리스트로 변환."""
    parsed = parse_content_md(filepath)
    workbook = parsed["workbook"]
    sheet = parsed["sheet"]
    parent_context = f"{workbook} / {sheet}" if workbook else sheet

    all_chunks = []
    for section in parsed["sections"]:
        chunks = chunk_section(section, parent_context)
        for chunk in chunks:
            # 메타데이터 부착
            chunk["workbook"] = workbook
            chunk["sheet"] = sheet
            chunk["section_path"] = chunk["heading"]
            chunk["has_mermaid"] = "```mermaid" in chunk["text"]
            chunk["has_table"] = bool(re.search(r'\|.*\|.*\|', chunk["text"]))
            chunk["has_images"] = "![" in chunk["text"]
            chunk["source_path"] = str(filepath)

            # 최소 토큰 필터
            if chunk["tokens"] >= MIN_CHUNK_TOKENS:
                all_chunks.append(chunk)

    return all_chunks


def discover_content_files(workbook_filter: str = None) -> list[Path]:
    """output/ 아래의 모든 _final/content.md 파일을 탐색."""
    if not EXTRACTOR_OUTPUT.exists():
        print(f"[ERROR] Output directory not found: {EXTRACTOR_OUTPUT}")
        return []

    files = []
    for content_md in sorted(EXTRACTOR_OUTPUT.rglob("_final/content.md")):
        if workbook_filter:
            # 워크북 디렉토리명으로 필터
            workbook_dir = content_md.parent.parent.parent.name
            if workbook_filter not in workbook_dir:
                continue
        files.append(content_md)

    return files


# ── 임베딩 ──

def embed_texts(texts: list[str], batch_size: int = 20) -> list[list[float]]:
    """Bedrock Titan Embeddings v2로 텍스트 목록을 임베딩."""
    token = os.environ.get("AWS_BEARER_TOKEN_BEDROCK")
    if not token:
        raise RuntimeError("AWS_BEARER_TOKEN_BEDROCK 환경변수 미설정")
    region = os.environ.get("AWS_REGION", "us-east-1")
    model_id = os.environ.get("EMBEDDING_MODEL", "amazon.titan-embed-text-v2:0")

    url = f"https://bedrock-runtime.{region}.amazonaws.com/model/{model_id}/invoke"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
    }

    all_embeddings = []
    for i in range(0, len(texts), batch_size):
        batch = texts[i:i + batch_size]
        batch_embeddings = []

        for text in batch:
            # Titan Embeddings는 단일 텍스트씩 호출
            # 텍스트 길이 제한 (8K 토큰 ≈ 8K 문자 한국어)
            truncated = text[:8000]
            body = {
                "inputText": truncated,
                "dimensions": 1024,
                "normalize": True,
            }

            resp = requests.post(url, json=body, headers=headers, timeout=30)
            if resp.status_code != 200:
                print(f"[WARN] Embedding API error {resp.status_code}: {resp.text[:200]}")
                # 제로 벡터 fallback
                batch_embeddings.append([0.0] * 1024)
                continue

            result = resp.json()
            batch_embeddings.append(result["embedding"])

        all_embeddings.extend(batch_embeddings)

        if i + batch_size < len(texts):
            print(f"  Embedded {i + batch_size}/{len(texts)} chunks...")

    return all_embeddings


# ── ChromaDB 저장 ──

def index_chunks(chunks: list[dict], reset: bool = False):
    """청크를 ChromaDB에 저장."""
    client = chromadb.PersistentClient(path=str(CHROMA_DIR))

    if reset:
        try:
            client.delete_collection(COLLECTION_NAME)
            print(f"[INFO] Collection '{COLLECTION_NAME}' deleted.")
        except Exception:
            pass

    collection = client.get_or_create_collection(
        name=COLLECTION_NAME,
        metadata={"hnsw:space": "cosine"},
    )

    # 기존 데이터 확인
    existing = collection.count()
    if existing > 0 and not reset:
        print(f"[INFO] Collection has {existing} existing documents. Adding new ones...")

    # 청크 텍스트 추출
    texts = [c["text"] for c in chunks]
    print(f"\n[INFO] Embedding {len(texts)} chunks...")

    t_start = time.time()
    embeddings = embed_texts(texts)
    t_embed = time.time() - t_start
    print(f"[INFO] Embedding complete: {t_embed:.1f}s ({len(texts) / max(t_embed, 0.1):.1f} chunks/s)")

    # ChromaDB에 추가
    ids = []
    metadatas = []
    documents = []

    for i, chunk in enumerate(chunks):
        # 고유 ID 생성
        chunk_id = f"{chunk['workbook']}__{chunk['sheet']}__{chunk['section_path']}__{i}"
        chunk_id = re.sub(r'[^a-zA-Z0-9가-힣_]', '_', chunk_id)[:512]

        ids.append(chunk_id)
        documents.append(chunk["text"])
        metadatas.append({
            "workbook": chunk["workbook"],
            "sheet": chunk["sheet"],
            "section_path": chunk["section_path"],
            "has_mermaid": chunk["has_mermaid"],
            "has_table": chunk["has_table"],
            "has_images": chunk["has_images"],
            "tokens": chunk["tokens"],
            "source_path": chunk["source_path"],
        })

    # 배치 추가 (ChromaDB 제한: 5461개씩)
    batch_size = 5000
    for i in range(0, len(ids), batch_size):
        end = min(i + batch_size, len(ids))
        collection.add(
            ids=ids[i:end],
            embeddings=embeddings[i:end],
            documents=documents[i:end],
            metadatas=metadatas[i:end],
        )

    print(f"[INFO] Indexed {len(ids)} chunks into ChromaDB.")
    print(f"[INFO] Total collection size: {collection.count()}")

    return collection


# ── 통계 ──

def print_stats(chunks: list[dict]):
    """청크 통계 출력."""
    total_tokens = sum(c["tokens"] for c in chunks)
    total_chars = sum(len(c["text"]) for c in chunks)
    workbooks = set(c["workbook"] for c in chunks)
    sheets = set(f"{c['workbook']}/{c['sheet']}" for c in chunks)

    mermaid_count = sum(1 for c in chunks if c.get("has_mermaid"))
    table_count = sum(1 for c in chunks if c.get("has_table"))
    image_count = sum(1 for c in chunks if c.get("has_images"))

    print(f"\n{'='*60}")
    print(f"Chunking Statistics")
    print(f"{'='*60}")
    print(f"  Total chunks:    {len(chunks)}")
    print(f"  Total tokens:    {total_tokens:,} (estimated)")
    print(f"  Total chars:     {total_chars:,}")
    print(f"  Avg tokens/chunk:{total_tokens / max(len(chunks), 1):.0f}")
    print(f"  Workbooks:       {len(workbooks)}")
    print(f"  Sheets:          {len(sheets)}")
    print(f"  With Mermaid:    {mermaid_count}")
    print(f"  With Tables:     {table_count}")
    print(f"  With Images:     {image_count}")
    print(f"{'='*60}")

    # 토큰 분포
    token_ranges = [(0, 200), (200, 500), (500, 1000), (1000, 1500), (1500, 2000), (2000, 99999)]
    print(f"\n  Token Distribution:")
    for low, high in token_ranges:
        count = sum(1 for c in chunks if low <= c["tokens"] < high)
        label = f"  {low}-{high}" if high < 99999 else f"  {low}+"
        bar = "#" * (count * 40 // max(len(chunks), 1))
        print(f"    {label:>10}: {count:>4} {bar}")


# ── 메인 ──

def main():
    import argparse

    parser = argparse.ArgumentParser(description="QnA PoC Indexer")
    parser.add_argument("--workbook", help="특정 워크북만 인덱싱 (부분 일치)")
    parser.add_argument("--stats", action="store_true", help="통계만 출력 (인덱싱 안 함)")
    parser.add_argument("--reset", action="store_true", help="기존 인덱스 삭제 후 재생성")
    args = parser.parse_args()

    # content.md 파일 탐색
    files = discover_content_files(args.workbook)
    print(f"[INFO] Found {len(files)} content.md files.")

    if not files:
        print("[ERROR] No content files found. Check EXTRACTOR_OUTPUT path.")
        sys.exit(1)

    # 청킹
    print("[INFO] Chunking...")
    t_start = time.time()
    all_chunks = []
    for f in files:
        chunks = chunk_file(f)
        all_chunks.extend(chunks)
    t_chunk = time.time() - t_start
    print(f"[INFO] Chunking complete: {t_chunk:.1f}s, {len(all_chunks)} chunks from {len(files)} files.")

    # 통계 출력
    print_stats(all_chunks)

    if args.stats:
        return

    # 인덱싱
    index_chunks(all_chunks, reset=args.reset)

    # 임베딩 비용 추정
    total_tokens = sum(c["tokens"] for c in all_chunks)
    cost = total_tokens * 0.00002 / 1000  # Titan v2 가격 대략
    print(f"\n[INFO] Estimated embedding cost: ${cost:.4f}")


if __name__ == "__main__":
    main()
