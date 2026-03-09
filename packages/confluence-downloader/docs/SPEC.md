# confluence-downloader 기술 스펙

> 3단계 파이프라인의 구현 상세. 각 단계의 입출력, API 사양, 변환 규칙을 정의한다.

---

## 1. 파이프라인 개요

```
Confluence Cloud
  │
  ├─ [Stage 1: Crawl]       REST API → 페이지 트리 구축
  ├─ [Stage 2: Download]    페이지 본문 + 첨부 이미지 다운로드
  └─ [Stage 3: Convert]     Storage Format → Markdown + 로컬 이미지
```

| Stage | 입력 | 출력 | 핵심 기술 |
|-------|------|------|-----------|
| Crawl | root page ID | 페이지 트리 (JSON) | REST API v1, 재귀 탐색 |
| Download | 페이지 ID | storage HTML + 이미지 바이너리 | Basic Auth, 페이지네이션, 재시도 |
| Convert | storage HTML | content.md + images/ | BeautifulSoup + markdownify |

---

## 2. 환경 설정

### API 인증

| 항목 | 값 |
|------|-----|
| 인증 방식 | Basic Auth (email + API token) |
| API 버전 | Confluence REST API v1 (`/rest/api`) |
| 베이스 URL | `{CONFLUENCE_URL}/rest/api` |

### .env 변수

```env
CONFLUENCE_URL=https://your-domain.atlassian.net/wiki
CONFLUENCE_USERNAME=your-email@company.com
CONFLUENCE_API_TOKEN=your-api-token-here
CONFLUENCE_SPACE_KEY=PK
CONFLUENCE_ROOT_PAGE_ID=3666773573
```

`.env` 파일 위치: `packages/confluence-downloader/.env`

---

## 3. Stage 1: Crawl (페이지 트리 구축)

### 3.1 API 엔드포인트

| 용도 | 엔드포인트 | 파라미터 |
|------|-----------|----------|
| 페이지 조회 | `GET /content/{id}` | `expand=version` |
| 하위 페이지 | `GET /content/{id}/child/page` | `limit=100, start=0, expand=version` |
| 첨부 파일 | `GET /content/{id}/child/attachment` | `limit=100, start=0` |

### 3.2 재귀 탐색

```
build_page_tree(root_id)
  → get_page(root_id)
  → get_children(root_id)
  → for each child:
      → build_page_tree(child.id)  # 재귀
```

- 깊이 제한: `--max-depth N` (기본: 무제한)
- 실시간 진행 표시: `\r  탐색 중... {N}개 페이지 발견 (현재: {title})`

### 3.3 레이트 리밋 & 재시도

| 상황 | 처리 |
|------|------|
| 요청 간격 | `request_delay` (기본 0.3초) |
| HTTP 429 (Rate Limit) | `Retry-After` 헤더만큼 대기 후 재시도 |
| HTTP 5xx (서버 오류) | 지수 백오프 (2, 4, 8초) × 최대 3회 재시도 |
| 타임아웃 | 페이지: 30초, 첨부파일: 60초 |

### 3.4 페이지네이션

하위 페이지/첨부 파일 API는 최대 100개씩 반환. `size < limit`이면 마지막 페이지.

```
start=0, limit=100 → results + size
if size < 100: break
else: start += 100, 반복
```

### 3.5 출력

```
output/
├── _tree.md           # 페이지 계층 구조 (Markdown 목록)
└── _manifest.json     # 전체 트리 메타데이터 (id, title, version, depth, output_path)
```

---

## 4. Stage 2: Download (페이지 본문 + 이미지)

### 4.1 페이지 본문 가져오기

```
GET /content/{id}?expand=body.storage,version
```

응답에서 추출:
- `body.storage.value` → Confluence Storage Format (HTML+XML 혼합)
- `version.number` → 페이지 버전 (변경 감지용)
- `_links.webui` → 원본 페이지 URL

### 4.2 첨부 파일 (이미지)

```
GET /content/{id}/child/attachment
```

각 첨부 파일 객체:
- `title` → 파일명 (e.g., `image-20250512-070355.png`)
- `_links.download` → 다운로드 경로 (상대 URL)

다운로드: `GET {base_url}{_links.download}`

### 4.3 이미지 다운로드 최적화

- Storage Format에서 실제 참조되는 이미지만 다운로드 (전체 첨부 파일 X)
- converter가 반환하는 `images_to_download` 리스트와 첨부 파일 목록을 매칭
- 매칭 실패 시 경고 출력, 다운로드 skip

### 4.4 skip-existing

`--skip-existing` 옵션: `content.md`가 이미 존재하면 해당 페이지 건너뛰기.
중단 후 재시작에 유용.

---

## 5. Stage 3: Convert (Storage Format → Markdown)

### 5.1 Confluence Storage Format

Confluence는 XHTML 기반 + Atlassian 고유 XML 네임스페이스의 혼합 포맷을 사용:

```xml
<p>일반 텍스트</p>
<ac:structured-macro ac:name="code">...</ac:structured-macro>
<ac:image><ri:attachment ri:filename="img.png"/></ac:image>
```

### 5.2 변환 파이프라인

```
Storage HTML
  │
  ├─ [1단계] BeautifulSoup 전처리
  │          Confluence XML 요소 → 표준 HTML 등가물로 변환
  │
  ├─ [2단계] markdownify 변환
  │          표준 HTML → Markdown (ATX 헤딩, `-` 불릿)
  │
  └─ [3단계] 후처리
             연속 빈 줄 정리 + 프론트매터 + 페이지 제목 삽입
```

### 5.3 Confluence 요소 변환 규칙

#### 5.3.1 이미지 (`ac:image`)

| 소스 | 변환 |
|------|------|
| `<ac:image><ri:attachment ri:filename="img.png"/></ac:image>` | `![img.png](images/img.png)` |
| `<ac:image><ri:url ri:value="https://..."/></ac:image>` | `![image](https://...)` |

#### 5.3.2 코드 블록 (`ac:structured-macro[name=code]`)

```xml
<ac:structured-macro ac:name="code">
  <ac:parameter ac:name="language">python</ac:parameter>
  <ac:plain-text-body><![CDATA[print("hello")]]></ac:plain-text-body>
</ac:structured-macro>
```
→ ` ```python\nprint("hello")\n``` `

CDATA 래핑 자동 제거.

#### 5.3.3 정보 패널 (`info`, `note`, `warning`, `tip`)

```xml
<ac:structured-macro ac:name="info">
  <ac:rich-text-body><p>중요 안내</p></ac:rich-text-body>
</ac:structured-macro>
```
→ `> ℹ️\n> 중요 안내`

| 매크로 | 프리픽스 |
|--------|---------|
| info | ℹ️ |
| note | 📝 |
| warning | ⚠️ |
| tip | 💡 |

#### 5.3.4 패널 (`panel`)

`ac:parameter[name=title]` 있으면 `> **제목**` 포함.
내용은 blockquote로 변환.

#### 5.3.5 확장 매크로 (`expand`)

```xml
<ac:structured-macro ac:name="expand">
  <ac:parameter ac:name="title">상세 보기</ac:parameter>
  <ac:rich-text-body>...</ac:rich-text-body>
</ac:structured-macro>
```
→ `<details><summary>상세 보기</summary>...</details>`

#### 5.3.6 링크 (`ac:link`)

| 소스 | 변환 |
|------|------|
| `<ac:link><ri:page ri:content-title="페이지명"/></ac:link>` | `[페이지명](#페이지명)` |
| `<ac:link><ri:attachment ri:filename="file.pdf"/></ac:link>` | `[file.pdf](images/file.pdf)` |

#### 5.3.7 체크리스트 (`ac:task-list`)

```xml
<ac:task-list>
  <ac:task>
    <ac:task-status>complete</ac:task-status>
    <ac:task-body>작업 완료</ac:task-body>
  </ac:task>
</ac:task-list>
```
→ `- ☑ 작업 완료`

#### 5.3.8 상태 라벨 (`status`)

→ `[STATUS_TEXT]` 인라인 텍스트로 변환.

#### 5.3.9 동적 매크로 (제거 대상)

다운로드 시점에 의미 없는 동적 매크로는 제거:
`children`, `include`, `excerpt-include`, `recently-updated`, `livesearch`, `jira`, `toc`

#### 5.3.10 알 수 없는 매크로

- `ac:rich-text-body` 있으면 → 내용만 추출
- `ac:plain-text-body` 있으면 → `<pre>` 블록으로
- 둘 다 없으면 → 제거

### 5.4 후처리

1. 연속 빈 줄 정리: `\n{3,}` → `\n\n`
2. 앞뒤 공백 trim
3. 페이지 제목 `# {title}` 삽입

### 5.5 프론트매터

각 `content.md` 상단에 YAML 프론트매터:

```yaml
---
confluence_id: 4072145042
title: "버프 (Buff) 만들기"
version: 3
source: https://bighitcorp.atlassian.net/wiki/spaces/PK/pages/...
downloaded: 2026-03-08 15:30:00
---
```

### 5.6 폴더명 새니타이징

`sanitize_filename(title)`:
- `<>:"/\\|?*` → `_`로 치환
- 한글, 영문, 숫자, 공백, 괄호 등은 유지
- 최대 80자
- 앞뒤 점/공백 제거

---

## 6. 출력 구조

### 6.1 전체 구조

```
output/
├── _tree.md                     # 전체 페이지 계층 (Markdown 목록)
├── _manifest.json               # 페이지 메타 (id, title, version, depth, output_path)
├── _download_results.json       # 다운로드 결과 상세 (status, size, images, videos, elapsed)
└── {PageTitle}/
    ├── content.md               # 페이지 본문 (프론트매터 + Markdown)
    ├── images/                  # 첨부 이미지 (참조된 것만)
    │   ├── screenshot.png
    │   └── diagram.png
    ├── videos/                  # 첨부 영상 (참조된 것만)
    │   └── demo.mp4
    └── {ChildPageTitle}/
        ├── content.md
        ├── images/
        └── videos/
```

### 6.2 계층 구조 ↔ Confluence 트리

Confluence 페이지 트리가 그대로 파일시스템 폴더 구조에 반영:
- 루트 페이지 "Design" → `output/Design/`
- 하위 "기획자 개발 팁" → `output/Design/기획자 개발 팁/`
- 그 하위 "전투 시뮬레이터" → `output/Design/기획자 개발 팁/전투 시뮬레이터/`

---

## 7. 실행 구조 (run.py)

### 7.1 CLI 옵션

| 옵션 | 기본값 | 설명 |
|------|--------|------|
| `--dry-run` | false | 페이지 트리만 조회, 다운로드 없음 |
| `--page-id` | .env ROOT_PAGE_ID | 시작 페이지 ID |
| `--max-depth` | -1 (무제한) | 최대 탐색 깊이 |
| `--skip-existing` | false | content.md 있는 페이지 건너뛰기 |
| `--output-dir` | ./output | 출력 디렉토리 |
| `--delay` | 0.3 | API 요청 간 딜레이(초) |

### 7.2 실행 순서

```
1. .env 로드 + 필수 변수 확인
2. ConfluenceClient 생성
3. build_page_tree() → 페이지 트리 구축 (실시간 진행 표시)
4. print_tree() → 트리 시각화 출력
5. resolve_output_path() → 각 노드에 파일시스템 경로 할당
6. _tree.md + _manifest.json 저장
7. [dry-run이면 여기서 종료]
8. download_tree() → 재귀적 다운로드
   - 각 페이지: download_page() → convert + save
   - 실시간 진행: [N/total %] title ✓/✗ (size, imgs, time)
9. print_summary() → 결과 요약
10. _download_results.json 저장
```

### 7.3 성능 로깅

각 페이지 완료 시 1줄 요약:
```
  [42/147 28%] [Beta1] 사냥터 개선 회의 자료 ✓ (1.9KB, 11img, 15.1s)
```

전체 완료 시 요약 테이블:
```
  총 페이지: 147
  성공: 145 | 건너뜀: 0 | 실패: 2
  총 크기: 850.3 KB (0.83 MB)
  이미지: 234개
  소요 시간: 423.5초
  API 요청: 892회 (평균 0.456초)
```

---

## 8. 기술 제약 및 알려진 이슈

| 이슈 | 영향 | 현황 |
|------|------|------|
| Confluence Cloud 전용 | Server/DC 버전 미지원 | Cloud REST API v1 기반 |
| API Rate Limit | 과도한 요청 시 429 반환 | 딜레이 + Retry-After 대응 |
| 5xx 간헐 오류 | Atlassian 서버 일시 장애 | 지수 백오프 3회 재시도 |
| 동적 매크로 손실 | children, jira 등 런타임 데이터 | 원본 URL 보존 (프론트매터) |
| 매크로 다양성 | 서드파티 매크로 미지원 | rich-text-body fallback |
| 페이지 내 상호 링크 | Confluence 내부 링크 → `#page-title` | 정확한 상대경로 미매핑 (향후) |

---

## 9. 영상 처리

### 9.1 현재 구현: 다운로드 + 참조 보존

영상 첨부 파일은 다운로드하여 `videos/` 폴더에 저장하고, Markdown에 참조를 남긴다.

**인식하는 매크로:**

| 매크로 | 변환 |
|--------|------|
| `ac:structured-macro[name=multimedia]` + `ri:attachment` | `[VIDEO: filename.mp4](videos/filename.mp4)` |
| `ac:structured-macro[name=view-file]` + `ri:attachment` | 영상이면 `[VIDEO: ...]`, 아니면 `[FILE: ...]` |
| `ac:structured-macro[name=widget]` + URL | `[EMBED: url](url)` (YouTube 등 외부 임베드) |

**인식하는 영상 확장자:** `.mp4`, `.mov`, `.avi`, `.wmv`, `.webm`, `.mkv`, `.flv`, `.m4v`

### 9.2 향후 계획: Gemini 영상 분석 파이프라인

다운로드된 영상 파일은 **Google Gemini API**로 분석하여 텍스트 지식으로 변환할 예정.

```
videos/*.mp4
  │
  ├─ [Gemini 2.0 Flash]  영상 전체를 입력 → 구조화된 설명 생성
  │    - 게임 플레이 흐름, UI 조작 순서, 전투 시연 내용 등
  │    - 타임스탬프별 주요 장면 요약
  │
  └─ [출력]  video_analysis.md (영상별 분석 결과)
             → content.md에 인라인 삽입 또는 별도 파일로 보관
```

**Gemini 선택 이유:**

| 모델 | 영상 직접 입력 | 최대 길이 | 비고 |
|------|---------------|-----------|------|
| **Gemini 2.0 Flash** | O | 수 시간 | 비용 효율적, 실시간 처리 |
| **Gemini 1.5 Pro** | O | 1시간+ | 더 정밀한 분석 |
| Claude Opus/Sonnet | X | - | 프레임 추출 후 이미지로만 가능 |
| GPT-4o | 프레임 기반 | - | 영상 직접 입력 불가 |

**구현 시점:** 전체 다운로드 완료 후, 영상 파일 수량/크기 파악 → 비용 산정 → 구현
