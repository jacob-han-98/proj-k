"""
전체 기획자료 일괄 변환 스크립트
================================
proj-k 기획 폴더의 모든 xlsx, pdf, pptx를 AI-Readable Markdown으로 변환

사용법:
  python run_all.py                       # 전체 변환
  python run_all.py --type xlsx           # xlsx만
  python run_all.py --type pdf            # pdf만
  python run_all.py --type pptx           # pptx만
  python run_all.py --dry-run             # 변환 대상만 확인
  python run_all.py --skip-existing       # 이미 변환된 파일 건너뛰기
"""

import os
import sys
import json
import time
import argparse
from pathlib import Path

# 같은 폴더의 변환 모듈 import
TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, TOOLS_DIR)

from convert_xlsx import convert_xlsx
from vision_reinforce import apply_corrections, apply_image_descriptions, load_yaml_data, write_reinforced_md

# PDF/PPTX는 라이브러리 없을 수 있으므로 lazy import
def _import_pdf():
    try:
        from convert_pdf import convert_pdf
        return convert_pdf
    except SystemExit:
        print("  ⚠ PDF 변환 라이브러리 없음 — PDF 건너뜀 (pip install pymupdf 또는 pdfplumber)")
        return None

def _import_pptx():
    try:
        from convert_pptx import convert_pptx
        return convert_pptx
    except ImportError:
        print("  ⚠ python-pptx 없음 — PPTX 건너뜀 (pip install python-pptx)")
        return None


def find_project_root():
    """_tools 폴더의 상위 = 프로젝트 루트"""
    return os.path.dirname(TOOLS_DIR)


def scan_files(project_root):
    """변환 대상 파일 스캔"""
    files = {'xlsx': [], 'pdf': [], 'pptx': []}

    for root, dirs, filenames in os.walk(project_root):
        # 출력/임시 폴더 건너뛰기
        dirs[:] = [d for d in dirs if d not in ('_knowledge_base', '_tools', '.git', '__pycache__')]

        for f in filenames:
            if f.startswith('~$') or f.startswith('.'):
                continue
            path = os.path.join(root, f)
            ext = f.rsplit('.', 1)[-1].lower()
            if ext in files:
                files[ext].append(path)

    return files


def check_existing(out_dir):
    """이미 변환된 파일 목록 확인"""
    existing = set()
    kb_dir = os.path.join(out_dir, '_knowledge_base')
    if not os.path.exists(kb_dir):
        return existing

    for root, dirs, files in os.walk(kb_dir):
        for f in files:
            if f == '_INDEX.json':
                index_path = os.path.join(root, f)
                try:
                    with open(index_path, 'r', encoding='utf-8') as fh:
                        data = json.load(fh)
                    if 'source_path' in data:
                        existing.add(data['source_path'])
                    elif 'source' in data:
                        existing.add(data['source'])
                except:
                    pass
    return existing


def apply_vision_reinforcements(out_dir):
    """변환 후 기존 vision 보강 파일(corrections, image_descriptions)을 자동 재적용

    out_dir 내의 *_corrections.json → _도형.yaml/_도형.md에 적용
    out_dir 내의 *_image_descriptions.json → 메인 .md에 적용
    """
    import glob as _glob
    applied = []

    # 1) corrections JSON → 도형 데이터 보강
    for corr_path in _glob.glob(os.path.join(out_dir, '*_corrections.json')):
        sheet_name = os.path.basename(corr_path).replace('_corrections.json', '')
        yaml_path = os.path.join(out_dir, f'{sheet_name}_도형.yaml')
        md_shape_path = os.path.join(out_dir, f'{sheet_name}_도형.md')

        if not os.path.exists(yaml_path) or not os.path.exists(md_shape_path):
            continue

        try:
            with open(corr_path, 'r', encoding='utf-8') as f:
                corrections_data = json.load(f)
            data = load_yaml_data(yaml_path)
            corrected_data, log = apply_corrections(data, corrections_data['corrections'])
            write_reinforced_md(md_shape_path, corrected_data, {'log': log}, md_shape_path)
            applied.append(f'도형보강: {sheet_name} ({len(log)}건)')
        except Exception as e:
            applied.append(f'도형보강 실패: {sheet_name} - {e}')

    # 2) image_descriptions JSON → 메인 MD에 이미지 설명 삽입
    for desc_path in _glob.glob(os.path.join(out_dir, '*_image_descriptions.json')):
        sheet_name = os.path.basename(desc_path).replace('_image_descriptions.json', '')
        md_path = os.path.join(out_dir, f'{sheet_name}.md')

        if not os.path.exists(md_path):
            continue

        try:
            with open(desc_path, 'r', encoding='utf-8') as f:
                desc_data = json.load(f)
            descriptions = desc_data.get('image_descriptions', [])
            if descriptions:
                apply_image_descriptions(md_path, descriptions)
                applied.append(f'이미지설명: {sheet_name} ({len(descriptions)}건)')
        except Exception as e:
            applied.append(f'이미지설명 실패: {sheet_name} - {e}')

    return applied


def main():
    parser = argparse.ArgumentParser(description='Project K 기획자료 전체 변환')
    parser.add_argument('--type', '-t', choices=['xlsx', 'pdf', 'pptx', 'all'], default='all')
    parser.add_argument('--dry-run', action='store_true', help='변환하지 않고 대상만 출력')
    parser.add_argument('--skip-existing', action='store_true', help='이미 변환된 파일 건너뛰기')
    args = parser.parse_args()

    project_root = find_project_root()
    print(f"프로젝트 루트: {project_root}")
    print(f"변환 유형: {args.type}\n")

    files = scan_files(project_root)

    # 통계
    print("=" * 60)
    print("변환 대상 파일 현황")
    print("=" * 60)
    print(f"  XLSX: {len(files['xlsx'])}개")
    print(f"  PDF:  {len(files['pdf'])}개")
    print(f"  PPTX: {len(files['pptx'])}개")
    total = sum(len(v) for v in files.values())
    print(f"  합계: {total}개")
    print()

    if args.dry_run:
        for ext, paths in files.items():
            if args.type != 'all' and ext != args.type:
                continue
            print(f"\n--- {ext.upper()} ({len(paths)}개) ---")
            for p in sorted(paths):
                rel = os.path.relpath(p, project_root)
                print(f"  {rel}")
        return

    # 변환 실행
    start_time = time.time()
    results = {'xlsx': {}, 'pdf': {}, 'pptx': {}}

    # XLSX 변환
    if args.type in ('all', 'xlsx') and files['xlsx']:
        print("\n" + "=" * 60)
        print(f"[XLSX 변환] {len(files['xlsx'])}개 파일")
        print("=" * 60)

        kb_sheets = os.path.join(project_root, '_knowledge_base', 'sheets')
        for i, xlsx_path in enumerate(sorted(files['xlsx']), 1):
            stem = Path(xlsx_path).stem.replace(' ', '_')
            out_dir = os.path.join(kb_sheets, stem)

            if args.skip_existing and os.path.exists(os.path.join(out_dir, '_INDEX.json')):
                print(f"[{i}/{len(files['xlsx'])}] 건너뛰기: {os.path.basename(xlsx_path)}")
                continue

            print(f"\n[{i}/{len(files['xlsx'])}]", end='')
            try:
                idx = convert_xlsx(xlsx_path, out_dir)
                # Vision 보강 자동 재적용
                reinforced = apply_vision_reinforcements(out_dir)
                if reinforced:
                    print(f"  [Vision 보강] {', '.join(reinforced)}")
                results['xlsx'][xlsx_path] = 'success'
            except Exception as e:
                print(f"  오류: {e}")
                results['xlsx'][xlsx_path] = f'error: {e}'

    # PDF 변환
    if args.type in ('all', 'pdf') and files['pdf']:
        convert_pdf = _import_pdf()
        if convert_pdf:
            print("\n" + "=" * 60)
            print(f"[PDF 변환] {len(files['pdf'])}개 파일")
            print("=" * 60)

            kb_pdfs = os.path.join(project_root, '_knowledge_base', 'pdfs')
            for i, pdf_path in enumerate(sorted(files['pdf']), 1):
                if args.skip_existing:
                    stem = Path(pdf_path).stem
                    import re as _re
                    clean_stem = _re.sub(r'\s*\[\d+\]\s*$', '', stem).strip().replace(' ', '_')
                    if os.path.exists(os.path.join(kb_pdfs, f"{clean_stem}.md")):
                        print(f"[{i}/{len(files['pdf'])}] 건너뛰기: {os.path.basename(pdf_path)}")
                        continue

                print(f"[{i}/{len(files['pdf'])}]", end='')
                try:
                    r = convert_pdf(pdf_path, kb_pdfs)
                    results['pdf'][pdf_path] = 'success'
                except Exception as e:
                    print(f"  오류: {e}")
                    results['pdf'][pdf_path] = f'error: {e}'

    # PPTX 변환
    if args.type in ('all', 'pptx') and files['pptx']:
        convert_pptx = _import_pptx()
        if convert_pptx:
            print("\n" + "=" * 60)
            print(f"[PPTX 변환] {len(files['pptx'])}개 파일")
            print("=" * 60)

            kb_pptx = os.path.join(project_root, '_knowledge_base', 'pptx')
            for i, pptx_path in enumerate(sorted(files['pptx']), 1):
                if args.skip_existing:
                    stem = Path(pptx_path).stem.replace(' ', '_')
                    if os.path.exists(os.path.join(kb_pptx, f"{stem}.md")):
                        print(f"[{i}/{len(files['pptx'])}] 건너뛰기: {os.path.basename(pptx_path)}")
                        continue

                print(f"[{i}/{len(files['pptx'])}]", end='')
                try:
                    r = convert_pptx(pptx_path, kb_pptx)
                    results['pptx'][pptx_path] = 'success'
                except Exception as e:
                    print(f"  오류: {e}")
                    results['pptx'][pptx_path] = f'error: {e}'

    # 최종 요약
    elapsed = time.time() - start_time
    print("\n" + "=" * 60)
    print("변환 완료 요약")
    print("=" * 60)
    for ext, res in results.items():
        if not res:
            continue
        success = sum(1 for v in res.values() if v == 'success')
        print(f"  {ext.upper()}: {success}/{len(res)} 성공")
    print(f"\n  소요 시간: {elapsed:.1f}초")


if __name__ == '__main__':
    main()
