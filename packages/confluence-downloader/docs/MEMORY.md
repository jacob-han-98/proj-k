# confluence-downloader — 세션 간 진행 기록

> 이 파일은 작업 세션 간 상태를 유지하기 위한 메모리 파일이다.
> 세션 시작 시 이 파일을 읽고, 작업 완료 시 업데이트한다.

## 핵심 방향

**Confluence REST API에서 직접 추출** (PDF 변환 경유 X)
- Storage Format → Markdown 직접 변환
- 이미지: 첨부 파일 API로 직접 다운로드
- `Confluence PDF Sync/` 폴더의 PDF 296개는 참고하지 않음

## 현재 상태 (2026-03-08)

- **초기 구축 완료**: client.py, converter.py, run.py 작성
- **시범 다운로드 완료**: 텍스트 페이지 1개 + 이미지 페이지 1개 검증 OK
- **다음 작업**: 전체 147페이지 다운로드 실행

### 완료된 작업

- [x] 패키지 구조 생성 (src/, docs/, .env)
- [x] Confluence REST API v1 클라이언트 (src/client.py)
- [x] Storage Format → Markdown 변환기 (src/converter.py)
- [x] 메인 실행 스크립트 (run.py) — dry-run, skip-existing 등
- [x] 문서: README.md, MEMORY.md

### 핵심 기술 결정

| 결정 | 선택 | 이유 |
|------|------|------|
| API 버전 | REST API v1 | v2보다 문서/예제 풍부, 안정적 |
| 인증 | Basic Auth (email+token) | Confluence Cloud 표준 방식 |
| HTML→MD | BeautifulSoup + markdownify | BS4로 Confluence XML 전처리 후 markdownify로 변환 |
| 출력 구조 | 계층적 폴더 (페이지 트리 반영) | 직관적, AI 지식베이스에 적합 |
| 이미지 | 로컬 다운로드 + 상대 경로 참조 | 오프라인 사용 가능, 자급자족 |

### 다음 작업

- [ ] 연결 테스트 (--dry-run)
- [ ] 1개 페이지 시범 다운로드 → 변환 품질 확인
- [ ] 전체 다운로드 실행
- [ ] 변환 품질 검증 (테이블, 이미지, 코드블록 등)
- [ ] 필요시 converter.py 매크로 핸들러 추가

## 파일 구조

```
packages/confluence-downloader/
├── src/
│   ├── __init__.py
│   ├── client.py          # Confluence REST API 클라이언트
│   └── converter.py       # Storage Format → Markdown 변환
├── run.py                 # 메인 실행 스크립트
├── .env                   # 접속 정보 (gitignored)
├── .env.example           # .env 템플릿
├── requirements.txt       # Python 의존성
├── output/                # 다운로드 결과 (gitignored)
└── docs/
    ├── README.md
    └── MEMORY.md           # 이 파일
```
