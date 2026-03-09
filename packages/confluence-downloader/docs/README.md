# confluence-downloader

Confluence Cloud에서 페이지 트리를 재귀적으로 다운로드하여 **Markdown + 이미지** 형태로 저장하는 도구.

## 목적

Confluence Cloud에서 REST API로 **직접** 페이지 본문과 이미지를 추출하여 AI가 읽을 수 있는 Markdown + 이미지 구조로 저장한다.
기존의 PDF 변환 방식(Confluence → PDF → 파싱)이 아닌, **Confluence Storage Format을 직접 Markdown으로 변환**하는 방식이다.
xlsx-extractor가 Excel 기획서를 변환했다면, 이 도구는 Confluence 기획서를 변환한다.

## 설치

```bash
cd packages/confluence-downloader
pip install -r requirements.txt
cp .env.example .env
# .env에 실제 Confluence 접속 정보 입력
```

## 사용법

```bash
# 1) 페이지 트리 확인 (다운로드 없이)
python run.py --dry-run

# 2) 전체 다운로드
python run.py

# 3) 특정 페이지부터 시작
python run.py --page-id 12345

# 4) 깊이 제한 (1단계 하위까지만)
python run.py --max-depth 1 --dry-run

# 5) 이미 변환된 페이지 건너뛰기 (중단 후 재시작)
python run.py --skip-existing
```

## 출력 구조

```
output/
├── _tree.md                  # 전체 페이지 계층 구조
├── _manifest.json            # 페이지 메타데이터 (ID, 버전 등)
├── _download_results.json    # 다운로드 결과 상세
└── {PageTitle}/
    ├── content.md            # 페이지 본문 (Markdown)
    ├── images/               # 첨부 이미지
    │   ├── screenshot.png
    │   └── diagram.png
    └── {ChildPage}/
        ├── content.md
        └── images/
```

각 `content.md`에는 YAML 프론트매터가 포함된다:
```yaml
---
confluence_id: 12345
title: "페이지 제목"
version: 3
source: https://domain.atlassian.net/wiki/...
downloaded: 2026-03-08 15:30:00
---
```

## 아키텍처

```
.env (Confluence 접속 정보)
  │
  ▼
src/client.py ─── Confluence REST API v1 클라이언트
  │                 - Basic Auth (email + API token)
  │                 - 페이지/하위페이지/첨부파일 조회
  │                 - 레이트 리밋 + 재시도
  │
  ▼
src/converter.py ─ Storage Format → Markdown 변환
  │                 - BeautifulSoup으로 Confluence XML 전처리
  │                 - markdownify로 HTML → Markdown 변환
  │                 - 이미지 참조를 로컬 경로로 변환
  │
  ▼
run.py ─────────── 오케스트레이션
                    - 재귀적 페이지 트리 탐색
                    - 각 페이지 다운로드 + 변환 + 저장
                    - 진행 상황 실시간 표시
                    - 결과 요약 리포트
```

## Confluence Storage Format 변환 규칙

| Confluence 요소 | Markdown 변환 |
|---|---|
| `ac:image` + `ri:attachment` | `![filename](images/filename)` |
| `ac:structured-macro[code]` | ` ```lang ... ``` ` |
| `ac:structured-macro[info/note/warning/tip]` | `> ℹ️/📝/⚠️/💡 ...` |
| `ac:structured-macro[panel]` | `> **title** ...` |
| `ac:structured-macro[expand]` | `<details><summary>` |
| `ac:link` + `ri:page` | `[title](#title)` |
| `ac:task-list` | `- ☑/☐ task` |
| `ac:structured-macro[toc]` | (제거) |
| 동적 매크로 (children, jira 등) | (제거) |

## 환경 변수

| 변수 | 설명 | 필수 |
|---|---|---|
| `CONFLUENCE_URL` | Confluence 인스턴스 URL | ✅ |
| `CONFLUENCE_USERNAME` | 이메일 주소 | ✅ |
| `CONFLUENCE_API_TOKEN` | API 토큰 | ✅ |
| `CONFLUENCE_SPACE_KEY` | 스페이스 키 | - |
| `CONFLUENCE_ROOT_PAGE_ID` | 시작 페이지 ID | ✅ |
