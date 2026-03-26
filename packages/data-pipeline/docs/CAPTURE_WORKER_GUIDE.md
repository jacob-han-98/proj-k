# Windows 캡처 워커 — 동작 명세

이 문서는 Windows PC에서 실행되는 캡처 워커의 전체 플로우를 설명한다.
서버(Linux)와 Windows PC 간 파일 교환은 모두 HTTP로 이루어진다.

## 실행 방법

```bash
cd packages/data-pipeline
python -m src.worker --id win-cap-1 --types capture --remote http://서버IP:8088 --poll 5
```

- `--remote`: 서버 API URL (필수). 이 옵션이 있으면 remote 모드로 동작
- `--types capture`: capture 작업만 처리
- `--poll 5`: 5초 간격으로 새 작업 폴링

## 전체 플로우

```
┌─────────────────────────────────────────────────────────────────┐
│ Windows 캡처 워커                                                │
│                                                                  │
│  1. POST /admin/pipeline/jobs/claim                              │
│     → 서버가 pending capture 작업 1개를 할당해줌                    │
│     → 받는 정보: job (아래 구조 참고)                               │
│                                                                  │
│  2. GET /admin/pipeline/documents/{doc_id}                       │
│     → 문서 메타 조회 (file_path, title 등)                        │
│                                                                  │
│  3. GET /admin/pipeline/documents/{doc_id}/download              │
│     → xlsx 원본 파일을 HTTP 스트리밍으로 다운로드                    │
│     → %TEMP%/pipeline-capture/{파일명}.xlsx 에 저장               │
│                                                                  │
│  4. capture.py 실행 (Excel COM)                                  │
│     → xlsx를 열어 시트별 스크린샷 캡처                              │
│     → output/{workbook_name}/ 에 결과 생성                        │
│                                                                  │
│  5. 결과를 zip으로 압축                                            │
│     → %TEMP%/capture_{document_id}.zip                           │
│                                                                  │
│  6. POST /admin/pipeline/documents/{doc_id}/capture-upload       │
│     → zip을 multipart/form-data로 업로드                          │
│     → 서버가 xlsx-extractor/output/ 에 압축 해제                   │
│                                                                  │
│  7. POST /admin/pipeline/jobs/{job_id}/complete                  │
│     → 작업 완료 보고                                               │
│                                                                  │
│  8. 임시파일 정리 (xlsx, zip, output 폴더)                         │
└─────────────────────────────────────────────────────────────────┘
```

## 1단계: 작업 수령 (job claim)

**요청**: `POST /admin/pipeline/jobs/claim?worker_id=win-cap-1&worker_types=capture`

**응답 예시**:
```json
{
  "job": {
    "id": 3512,
    "job_type": "capture",
    "source_id": 1,
    "document_id": 42,
    "status": "assigned",
    "priority": 5,
    "worker_type": "windows",
    "worker_id": "win-cap-1",
    "params": "{}",
    "created_at": "2026-03-26T10:00:00",
    "assigned_at": "2026-03-26T10:00:01"
  }
}
```

작업이 없으면 `{"job": null}` 반환 → poll_interval만큼 대기 후 재시도.

핵심 필드:
- **`job.id`**: 작업 ID (완료/실패 보고 시 사용)
- **`job.document_id`**: 문서 ID (파일 다운로드, 결과 업로드 시 사용)
- **`job.source_id`**: 소스 ID (어떤 소스의 문서인지)

## 2단계: 문서 정보 조회

**요청**: `GET /admin/pipeline/documents/{document_id}`

**응답 예시**:
```json
{
  "id": 42,
  "source_id": 1,
  "file_path": "PK_HUD 시스템.xlsx",
  "file_type": "xlsx",
  "title": "PK_HUD 시스템",
  "status": "crawled"
}
```

- **`file_path`**: 원본 파일의 상대 경로 (소스 내 위치)
- 다운로드 시에는 이 경로가 아니라 `/documents/{id}/download` 엔드포인트 사용

## 3단계: xlsx 파일 다운로드

**요청**: `GET /admin/pipeline/documents/{document_id}/download`

**응답**: xlsx 바이너리 스트림 (Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet)

**저장 위치**: `%TEMP%/pipeline-capture/{file_path의 파일명}` (예: `PK_HUD 시스템.xlsx`)

```python
# remote_db.py의 download_document_file() 참고
r = requests.get(url, stream=True, timeout=120)
with open(dest_path, "wb") as f:
    shutil.copyfileobj(r.raw, f)
```

## 4단계: 캡처 실행

`xlsx-extractor/src/capture.py`를 subprocess로 실행:

```bash
python capture.py <xlsx_path> <output_base>
```

- `<xlsx_path>`: 다운로드한 임시 xlsx 경로
- `<output_base>`: 캡처 결과가 저장될 상위 디렉토리

### 캡처 결과 구조

```
output_base/
└── PK_HUD 시스템/                    # workbook_name (xlsx 파일명에서 확장자 제거)
    ├── _capture_manifest.json        # 워크북 전체 캡처 요약
    ├── HUD_기본/                     # sheet_name
    │   └── _vision_input/
    │       ├── full_original.png     # 시트 전체 스크린샷 (원본 크기)
    │       ├── overview.png          # 축소 개요 이미지 (max 1568px width)
    │       ├── detail_r0.png         # 상세 타일 (세로 분할)
    │       ├── detail_r1.png
    │       ├── ...
    │       └── tile_manifest.json    # 타일 분할 메타데이터
    └── HUD_전투/
        └── _vision_input/
            ├── full_original.png
            ├── overview.png
            ├── detail_r0.png
            └── tile_manifest.json
```

### _capture_manifest.json 구조

```json
{
  "source": "PK_HUD 시스템.xlsx",
  "capture_method": "excel_com_copypicture",
  "sheet_count": 3,
  "captured": 2,
  "sheets": [
    {
      "index": 0, "name": "히스토리",
      "capture_success": true, "blank": true
    },
    {
      "index": 1, "name": "HUD_기본",
      "capture_success": true, "blank": false,
      "split_success": true,
      "width": 5226, "height": 4879,
      "tile_count": 5
    }
  ]
}
```

### tile_manifest.json 구조

```json
{
  "sheet_name": "HUD_기본",
  "full_image": { "width": 5226, "height": 4879 },
  "overview": { "width": 1568, "height": 1463, "scaled": true },
  "total_rows": 5,
  "tiles": [
    {
      "tile_id": "detail_r0",
      "row_index": 0, "total_rows": 5,
      "pixel_region": { "x": 0, "y": 0, "w": 1798, "h": 1441 },
      "position_description": "section 1/5"
    }
  ]
}
```

## 5단계: zip 압축

캡처 결과 전체를 ZIP_DEFLATED로 압축:

```
capture_{document_id}.zip
└── PK_HUD 시스템/                  # safe_name (워크북명)
    ├── _capture_manifest.json
    ├── HUD_기본/
    │   └── _vision_input/
    │       ├── full_original.png
    │       ├── overview.png
    │       ├── detail_r*.png
    │       └── tile_manifest.json
    └── HUD_전투/
        └── _vision_input/
            └── ...
```

zip 내부 경로가 중요: `{workbook_name}/{sheet_name}/_vision_input/...` 구조를 유지해야 서버에서 올바른 위치에 압축 해제됨.

## 6단계: 결과 업로드

**요청**: `POST /admin/pipeline/documents/{document_id}/capture-upload`
- Content-Type: `multipart/form-data`
- Form field: `file` (zip 바이너리)

**응답 예시**:
```json
{
  "status": "ok",
  "document_id": 42,
  "extracted_files": 18,
  "size_mb": 5.2,
  "output_base": "/home/jacob/repos/proj-k/packages/xlsx-extractor/output"
}
```

서버는 zip을 `xlsx-extractor/output/` 에 압축 해제한다.
후속 convert 단계에서 이 파일들을 읽어 Vision AI + OOXML 합성을 수행한다.

```python
# remote_db.py의 upload_capture_result() 참고
with open(zip_path, "rb") as f:
    r = requests.post(url, files={"file": (name, f, "application/zip")}, timeout=300)
```

## 7단계: 작업 완료/실패 보고

**성공**: `POST /admin/pipeline/jobs/{job_id}/complete`
- Body: `{"capture_dir": "...", "sheet_count": N, "ok": N, "failed": 0}`

**실패**: `POST /admin/pipeline/jobs/{job_id}/fail?error_message=...`
- 실패 시 자동 retry (최대 3회). 3회 초과 시 영구 실패.

## 8단계: 임시파일 정리

- `%TEMP%/pipeline-capture/*.xlsx` — 다운로드한 원본
- `%TEMP%/capture_*.zip` — 업로드용 zip
- `output/{workbook_name}/` — 캡처 결과 (업로드 완료 후)

## API 엔드포인트 요약

| 단계 | Method | Path | 용도 |
|------|--------|------|------|
| 하트비트 | POST | `/admin/pipeline/workers/heartbeat?worker_id=...&worker_types=capture&job_types=capture` | 워커 생존 신호 |
| 작업 수령 | POST | `/admin/pipeline/jobs/claim?worker_id=...&worker_types=capture` | pending → assigned |
| 작업 시작 | POST | `/admin/pipeline/jobs/{id}/start` | assigned → running |
| 문서 조회 | GET | `/admin/pipeline/documents/{doc_id}` | 문서 메타데이터 |
| 파일 다운로드 | GET | `/admin/pipeline/documents/{doc_id}/download` | xlsx 원본 스트리밍 |
| 결과 업로드 | POST | `/admin/pipeline/documents/{doc_id}/capture-upload` | zip multipart 업로드 |
| 작업 완료 | POST | `/admin/pipeline/jobs/{id}/complete` | 성공 보고 |
| 작업 실패 | POST | `/admin/pipeline/jobs/{id}/fail?error_message=...` | 실패 보고 |

모든 엔드포인트의 base URL: `http://서버IP:8088`

## 의존성 (Windows)

```
pip install requests pywin32 Pillow openpyxl numpy python-dotenv
```

- `pywin32`: Excel COM 자동화 (CopyPicture)
- `Pillow`: 이미지 처리 (리사이즈, 분할)
- `numpy`: 이미지 분석 (빈 공간 크롭)
- `requests`: HTTP API 통신
