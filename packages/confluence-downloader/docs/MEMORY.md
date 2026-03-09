# confluence-downloader — 세션 간 진행 기록

> 이 파일은 작업 세션 간 상태를 유지하기 위한 메모리 파일이다.
> 세션 시작 시 이 파일을 읽고, 작업 완료 시 업데이트한다.

## 핵심 방향

**Confluence REST API에서 직접 추출** (PDF 변환 경유 X)
- Storage Format → Markdown 직접 변환
- 이미지: 첨부 파일 API로 직접 다운로드
- `Confluence PDF Sync/` 폴더의 PDF 296개는 참고하지 않음

## 현재 상태 (2026-03-09)

- **전체 다운로드 완료**: 490개 페이지, 489개 content.md, ~2,195개 이미지
- **output 크기**: 8.2 GB (대부분 이미지)
- **다음 작업**: 변환 품질 검증, 필요시 converter.py 매크로 핸들러 보강

### 완료된 작업

- [x] 패키지 구조 생성 (src/, docs/, .env)
- [x] Confluence REST API v1 클라이언트 (src/client.py)
- [x] Storage Format → Markdown 변환기 (src/converter.py)
- [x] 메인 실행 스크립트 (run.py) — dry-run, skip-existing 등
- [x] 문서: README.md, MEMORY.md, SPEC.md, VERIFICATION.md
- [x] 시범 다운로드 (텍스트 1개 + 이미지 1개) → 검증 OK
- [x] v1 child/page → CQL `parent={id}` 전환 (folder 타입 포함)
- [x] 전체 490페이지 다운로드 완료 (실패 0건)

### 핵심 기술 결정

| 결정 | 선택 | 이유 |
|------|------|------|
| API 버전 | REST API v1 + CQL | v2 folder API 불안정, CQL이 page+folder 모두 반환 |
| 인증 | Basic Auth (email+token) | Confluence Cloud 표준 방식 |
| HTML→MD | BeautifulSoup + markdownify | BS4로 Confluence XML 전처리 후 markdownify로 변환 |
| 출력 구조 | 계층적 폴더 (페이지 트리 반영) | 직관적, AI 지식베이스에 적합 |
| 이미지 | 로컬 다운로드 + 상대 경로 참조 | 오프라인 사용 가능, 자급자족 |
| children 탐색 | CQL `parent = {id}` | v1 child/page는 folder 누락, CQL이 유일한 정확한 방법 |

### 다음 작업

- [ ] 변환 품질 검증 (테이블, 이미지, 코드블록, 매크로 등)
- [ ] 필요시 converter.py 매크로 핸들러 추가
- [ ] 영상 다운로드 확인 (영상 포함 페이지 존재 시)

### 주요 이슈 해결 기록

| 이슈 | 원인 | 해결 |
|------|------|------|
| Windows cp949 인코딩 에러 | `print()` emoji on cp949 | UTF-8 stdout wrapper |
| 503 서버 에러 | Confluence 간헐적 과부하 | 지수 백오프 재시도 (2, 4, 8초) |
| folder 타입 누락 (147→490) | v1 child/page가 folder 미반환 | CQL `parent={id}`로 전환 |
| 디스크 부족 120건 실패 | 이미지 대량 (8GB+) | 디스크 확보 후 skip-existing 재실행 |

## 파일 구조

```
packages/confluence-downloader/
├── src/
│   ├── __init__.py
│   ├── client.py          # Confluence REST API 클라이언트 (CQL 기반)
│   └── converter.py       # Storage Format → Markdown 변환
├── run.py                 # 메인 실행 스크립트
├── .env                   # 접속 정보 (gitignored)
├── .env.example           # .env 템플릿
├── requirements.txt       # Python 의존성
├── output/                # 다운로드 결과 (gitignored, 8.2GB)
└── docs/
    ├── README.md
    ├── SPEC.md
    ├── VERIFICATION.md
    └── MEMORY.md           # 이 파일
```
