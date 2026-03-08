# xlsx-extractor

Excel 기획서에서 AI가 활용할 수 있는 지식(텍스트 + 이미지)을 추출하는 서브 프로젝트.

## 상위 프로젝트

**Project K AI 기획 어시스턴트** (`proj-k 기획/`)의 1단계(지식화)를 구성하는 핵심 모듈.
상위 프로젝트는 104개 Excel, 296개 PDF, 11개 PPTX 기획서를 AI 지식 베이스로 변환하는 것이 목표이며,
이 서브 프로젝트는 그 중 **Excel(XLSX) 변환**을 담당한다.

## 목표

1. Excel 기획서의 모든 정보(텍스트, 테이블, 플로우차트, 도형, 이미지)를 **구조화된 Markdown**으로 변환
2. 텍스트로 표현 불가능한 시각 요소는 **서브 이미지**로 분리하여 Markdown에서 참조
3. Vision AI 자동 검증으로 변환 품질 보장
4. 다른 서브 프로젝트(pdf-extractor, pptx-extractor 등)에서 재사용 가능한 구조

## 핵심 방법론

```
Excel 시트
  |
  v
[Stage 1: Capture] LibreOffice headless -> 시트별 이미지
  |  원본 전체 이미지 + 스케일다운 개요 이미지 + 분할 상세 이미지
  v
[Stage 2: Vision] Claude Opus Vision API (2-이미지 전략)
  |  개요(위치 맥락) + 상세(정밀 해석) 동시 전달
  |  텍스트 우선 해석 / 불가 요소만 서브 이미지로 분리
  v
[Stage 3: Parse] openpyxl 데이터 보강
  |  수치, 수식, 숨겨진 셀 등 Vision이 약한 부분 보강
  v
[Stage 4: Synthesize] 최종 Markdown + 서브 이미지 생성
  |
  v
[Verify] Vision AI 랜덤 질의 검증
```

상세 스펙은 [SPEC.md](SPEC.md), 검증 프로토콜은 [VERIFICATION.md](VERIFICATION.md) 참조.

## 출력 구조

```
output/
├── {ExcelFileName}/
│   ├── {SheetName}/
│   │   ├── _vision_input/          # Vision AI 입력용 이미지
│   │   │   ├── full_original.png   # 시트 전체 고해상도
│   │   │   ├── overview.png        # 스케일다운 개요
│   │   │   ├── detail_r0_c0.png    # 분할 상세 이미지들
│   │   │   └── ...
│   │   ├── _final/                 # 최종 출력물
│   │   │   ├── content.md          # 구조화된 텍스트
│   │   │   └── images/             # 서브 이미지 (텍스트 불가 요소)
│   │   │       ├── figure_01.png
│   │   │       └── ...
│   │   └── _meta/                  # 메타데이터
│   │       ├── extraction_log.json
│   │       └── verification.json
│   └── {SheetName2}/
│       └── ...
```

## 의존성 (향후 구현 시)

- Python 3.10+
- LibreOffice 26.x (headless)
- openpyxl, PyMuPDF (fitz), Pillow
- AWS Bedrock (Claude Opus Vision API)
- python-dotenv

## 관련 파일

| 파일 | 설명 |
|------|------|
| `ConvertProgram/_tools/lo_sheet_export.py` | LibreOffice 시트별 PDF 내보내기 (재사용 대상) |
| `ConvertProgram/_tools/vision_first_convert.py` | Vision-First 파이프라인 참조 구현 |
| `ConvertProgram/_tools/convert_xlsx.py` | Tier 1+1.5 openpyxl/OOXML 파싱 (재사용 대상) |
| `ConvertProgram/.env` | AWS Bedrock 인증 정보 |
