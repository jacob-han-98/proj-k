"""
PDF → AI-Readable Markdown 변환 파이프라인
==========================================
Confluence PDF 등에서 텍스트를 추출하여 구조화된 Markdown으로 변환

사용법:
  python convert_pdf.py "경로/파일.pdf"
  python convert_pdf.py --batch "폴더경로"

의존성: pymupdf (pip install pymupdf) 또는 pdfplumber (pip install pdfplumber)
         둘 다 없으면 pdfminer.six (pip install pdfminer.six) 사용
"""

import os
import sys
import json
import re
import argparse
from pathlib import Path

# PDF 라이브러리 우선순위: pymupdf > pdfplumber > pdfminer
PDF_BACKEND = None

try:
    import fitz  # PyMuPDF
    PDF_BACKEND = 'pymupdf'
except ImportError:
    try:
        import pdfplumber
        PDF_BACKEND = 'pdfplumber'
    except ImportError:
        try:
            from pdfminer.high_level import extract_text as pdfminer_extract
            PDF_BACKEND = 'pdfminer'
        except ImportError:
            print("PDF 라이브러리가 필요합니다. 다음 중 하나를 설치하세요:")
            print("  pip install pymupdf")
            print("  pip install pdfplumber")
            print("  pip install pdfminer.six")
            sys.exit(1)


def extract_pdf_text(pdf_path):
    """PDF에서 텍스트 추출 + 기본 구조화 (백엔드 자동 선택)"""
    pages = []

    if PDF_BACKEND == 'pymupdf':
        doc = fitz.open(pdf_path)
        for page_num in range(len(doc)):
            page = doc[page_num]
            text = page.get_text("text")
            if text.strip():
                pages.append(text)
        doc.close()

    elif PDF_BACKEND == 'pdfplumber':
        with pdfplumber.open(pdf_path) as pdf:
            for page in pdf.pages:
                text = page.extract_text()
                if text and text.strip():
                    pages.append(text)

    elif PDF_BACKEND == 'pdfminer':
        full_text = pdfminer_extract(pdf_path)
        if full_text and full_text.strip():
            # pdfminer는 페이지 구분이 어려우므로 폼피드로 분할
            raw_pages = full_text.split('\x0c')
            pages = [p for p in raw_pages if p.strip()]
            if not pages:
                pages = [full_text]

    return pages


def structure_confluence_pdf(pages, filename):
    """Confluence PDF를 구조화된 Markdown으로 변환"""
    md = f"# {Path(filename).stem}\n\n"
    md += f"> 원본: {filename}\n"
    md += f"> 페이지: {len(pages)}\n\n"

    full_text = '\n'.join(pages)

    # Confluence PDF의 일반적인 패턴 처리
    lines = full_text.split('\n')
    in_table = False
    table_rows = []

    for line in lines:
        stripped = line.strip()
        if not stripped:
            if in_table and table_rows:
                # 테이블 출력
                md += format_table(table_rows)
                table_rows = []
                in_table = False
            md += "\n"
            continue

        # Confluence 헤더 패턴
        if re.match(r'^#{1,6}\s', stripped):
            md += f"{stripped}\n\n"
        # 번호 매기기
        elif re.match(r'^\d+\.\s', stripped):
            md += f"{stripped}\n"
        # 불릿
        elif stripped.startswith('•') or stripped.startswith('·'):
            md += f"- {stripped[1:].strip()}\n"
        # 일반 텍스트
        else:
            md += f"{stripped}\n"

    return md


def format_table(rows):
    """간단한 테이블 포맷팅"""
    if not rows or len(rows) < 2:
        return '\n'.join(rows) + '\n'

    md = f"| {' | '.join(rows[0])} |\n"
    md += f"| {' | '.join(['---'] * len(rows[0]))} |\n"
    for row in rows[1:]:
        md += f"| {' | '.join(row)} |\n"
    return md


def convert_pdf(pdf_path, out_dir=None):
    """단일 PDF 파일 변환"""
    pdf_path = os.path.abspath(pdf_path)
    filename = os.path.basename(pdf_path)
    stem = Path(pdf_path).stem

    # Confluence PDF에서 ID 제거 (예: "길드 시스템 [4629889029].pdf" → "길드_시스템")
    clean_stem = re.sub(r'\s*\[\d+\]\s*$', '', stem).strip().replace(' ', '_')

    if out_dir is None:
        base = os.path.dirname(pdf_path)
        # Confluence PDF는 batch 폴더 기준으로
        kb_dir = os.path.join(base, '..', '..', '_knowledge_base', 'pdfs')
        out_dir = os.path.abspath(kb_dir)

    os.makedirs(out_dir, exist_ok=True)

    print(f"  변환: {filename}")

    pages = extract_pdf_text(pdf_path)
    if not pages:
        print(f"    (텍스트 없음 - 이미지 기반 PDF)")
        return {'status': 'empty', 'filename': filename}

    md = structure_confluence_pdf(pages, filename)
    out_path = os.path.join(out_dir, f"{clean_stem}.md")

    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(md)

    print(f"    → {len(md):,} chars, {len(pages)} pages")

    return {
        'status': 'success',
        'filename': filename,
        'output': out_path,
        'pages': len(pages),
        'chars': len(md)
    }


def main():
    parser = argparse.ArgumentParser(description='PDF → AI-Readable Markdown 변환')
    parser.add_argument('input', nargs='?', help='PDF 파일 경로')
    parser.add_argument('--out', '-o', help='출력 폴더')
    parser.add_argument('--batch', '-b', help='폴더 내 모든 PDF 일괄 변환')

    args = parser.parse_args()

    if args.batch:
        batch_dir = os.path.abspath(args.batch)
        pdf_files = []
        for root, dirs, files in os.walk(batch_dir):
            dirs[:] = [d for d in dirs if d != '_knowledge_base' and d != '_tools']
            for f in files:
                if f.endswith('.pdf') and not f.startswith('.'):
                    pdf_files.append(os.path.join(root, f))

        print(f"발견된 PDF 파일: {len(pdf_files)}개\n")

        out_dir = args.out or os.path.join(batch_dir, '_knowledge_base', 'pdfs')
        os.makedirs(out_dir, exist_ok=True)

        results = {}
        success = 0
        for i, pdf in enumerate(sorted(pdf_files), 1):
            print(f"[{i}/{len(pdf_files)}]", end='')
            try:
                r = convert_pdf(pdf, out_dir)
                results[pdf] = r
                if r['status'] == 'success':
                    success += 1
            except Exception as e:
                print(f"  오류: {e}")
                results[pdf] = {'status': 'error', 'error': str(e)}

        # 인덱스 저장
        index_path = os.path.join(out_dir, "_INDEX.json")
        with open(index_path, 'w', encoding='utf-8') as f:
            json.dump({
                'total': len(results),
                'success': success,
                'total_chars': sum(r.get('chars', 0) for r in results.values()),
                'files': {os.path.basename(k): v for k, v in results.items()}
            }, f, ensure_ascii=False, indent=2)

        print(f"\n{'='*60}")
        print(f"배치 완료: {success}/{len(results)} 성공")
        total_chars = sum(r.get('chars', 0) for r in results.values())
        print(f"총 {total_chars:,} chars 추출")
        return results

    elif args.input:
        return convert_pdf(args.input, args.out)
    else:
        parser.print_help()


if __name__ == '__main__':
    main()
