# Project K 데이터 파이프라인 — 크롤·변환·인덱싱 (운영 절차)

> AI-TEST-02(개발 서버) 기준. 향후 cp.tech2 호스팅 예정.
> 운영 콘솔: `klaud_dashboard.py` (:8092) · CLI: `scripts/klaud-crawl.py`

## 1. 전체 구조

```
3개 소스 ──────────────▶ content.md ──┬─▶ [마크다운 인덱스]  summaries → MASTER_INDEX / TERM_INDEX
                                       └─▶ [벡터 인덱스]      ChromaDB(project_k, Titan v2)
                                                                       │
                          DataSheet ───────────────▶ game_data.db (SQLite, MCP query_game_table)
```

### 소스 (3 파이프라인)
| # | 소스 | 경로 | 변환 | 산출 |
|---|------|------|------|------|
| 1 | **Confluence** | REST API (root page) | HTML→Markdown | `confluence-downloader/output/**/content.md` |
| 2 | **p4 GDD** (7_System+8_Contents **만**) | `//main/ProjectK/Design/{7_System,8_Contents}` | **OnlyOffice headless → Vision** | `xlsx-extractor/output/{7_System,8_Contents}/**/content.md` |
| 3 | **p4 DataSheet** | `//main/ProjectK/Resource/design` | table-parser(결정적) | `~/.qna-poc-gamedata/game_data.db` |

### 인덱스 (2 레이어 — 둘 다 최신 유지 필수)
| 레이어 | 산출물 | 빌더 | 비용 | 소비자 |
|--------|--------|------|------|--------|
| **마크다운** | `index/summaries/`, `MASTER_INDEX.md`, `TERM_INDEX.md` | build_summaries(LLM 요약) → build_master_index/build_term_index(무비용 집계) | 요약만 LLM | agent Grep/Read, **Klaud 빠른검색 L1(키워드)** |
| **벡터** | ChromaDB `~/.qna-poc-chroma` 컬렉션 `project_k` | qna-poc `indexer`(청크→Titan v2 임베딩) | Titan(저렴) | **Klaud 빠른검색 벡터(의미검색)** |

> **Klaud 빠른검색**: 타이핑 중(`fast`)=L1 키워드만 / Enter=L1 + 벡터 병렬(`🧬 의미 검색`). 벡터 컬렉션이 없거나 stale 이면 의미검색이 조용히 빈 결과로 degrade → **두 인덱스를 항상 같이 갱신해야 함.**

---

## 2. 마크다운 인덱스 절차

### 빌드/갱신
```
content.md → build_summaries.py (--file/--workbook/--space/--all, LLM/Haiku, 1:1 요약)
           → build_master_index.py + build_term_index.py (전체 재집계, LLM 없음)
```
- **MASTER_INDEX**: 분류(7_System/8_Contents)→워크북→시트, 공간→페이지 TOC + one_liner
- **TERM_INDEX**: 요약의 "핵심 용어"/"참조 시스템" 역색인 (용어→등장 시트/페이지)
- 둘 다 매번 전체 재집계(증분 아님) → 요약만 갱신하면 정확히 반영

## 3. 벡터 DB(ChromaDB) 절차

### 구성
- DB: ChromaDB persistent `~/.qna-poc-chroma`, 컬렉션 `project_k`
- 임베딩: **Amazon Titan Embeddings v2** (`amazon.titan-embed-text-v2:0`, 1024d, normalize) — `AWS_BEARER_TOKEN_BEDROCK` 필요
- 청크 메타: workbook/sheet/section_path/tokens/source_path/has_table/has_images/has_mermaid

### 초기 전체 구축
```bash
# chromadb 설치 (1회)
.venv/bin/python -m pip install chromadb
# 전체 재구축 (현재 모든 content.md → 청크 → Titan 임베딩 → project_k)
cd packages/qna-poc && python -m src.indexer --source all --reset
#   부분: --source excel|confluence, --workbook "이름", --stats(통계만)
```

### 증분 갱신 (append-only 중복 방지 — purge 선행 필수)
`index_chunks` 는 결정적 id 로 `collection.add` 하므로, 같은 리소스 재인덱싱 시 **반드시 기존 청크 purge 후** 재인덱싱:
```
변경 content.md → purge_chromadb_chunks(source, paths)   # 기존 청크 제거
               → chunk_file(content.md) → index_chunks(reset=False)  # Titan 임베딩 + upsert
```

---

## 4. 자동화 — klaud-crawl 가 두 인덱스를 함께 갱신

`reindex-run`/`sync` 가 각 변경 리소스에 대해 **마크다운 + 벡터**를 같이 갱신한다:

```
reindex-run (stale/failed 처리)
  confluence: download_page → build_summaries(마크다운) → _update_vector_db(벡터)
  p4 GDD    : p4 sync → OnlyOffice 변환 → build_summaries(마크다운) → _update_vector_db(벡터)
  끝에: MASTER/TERM 재집계 (마크다운 1회)
purge/이동 정리: 로컬 + 요약 + crawl_state + ChromaDB 청크 모두 제거(데이터 동기)
```
- 벡터 갱신: `_update_vector_db(source, [(resource_path, content_md)…])` (klaud-crawl.py) — `purge_chromadb_chunks` → `chunk_file` → `index_chunks`
- env `PROJK_VECTOR_INDEX=0` 으로 끌 수 있음. chromadb/Titan 미가용 시 graceful skip(마크다운엔 영향 없음).

### 명령
```bash
klaud-crawl status [--status failed]            # 현황
klaud-crawl report [--source <s>] [--purge-missing]   # 저장소 vs 로컬 diff (+삭제/이동 정리)
klaud-crawl reindex-run [--source <s>] [--limit N] [--dry-run] [--no-index]
klaud-crawl sync [--purge]                      # cron-tick→reindex(마크다운+벡터)→DataSheet→report
# systemd: klaud-crawl-sync.timer (hourly, --purge) → 시간당 자동 동기
```

---

## 5. 환경 / 위치
- 데이터 루트: `/home/jacob/proj-k-data` (output 심볼릭 링크 타겟), p4 sync: `/home/jacob/p4sync`
- game_data.db: `~/.qna-poc-gamedata/game_data.db`, 벡터: `~/.qna-poc-chroma`
- 크롤 venv: `packages/xlsx-extractor/.venv` (+chromadb, bs4, markdownify, dotenv, httpx)
- 자격: P4 `scripts/.env`, Confluence `confluence-downloader/.env`, Bedrock(Titan/요약/Vision) `xlsx-extractor/.env`
- LLM 모델: 변환 Vision/OCR/foundation = **Opus 4.8**(`global.anthropic.claude-opus-4-8`), 요약 = Haiku 4.5, 임베딩 = Titan v2

## 6. 주의 (Gotchas)
- **벡터·마크다운 동시 갱신**: 한쪽만 갱신하면 Klaud 키워드/의미검색 결과가 어긋남. reindex-run/sync 가 둘 다 처리하도록 유지.
- **purge 선행**: 벡터는 append-only → 재인덱싱 전 purge 안 하면 청크 중복.
- **대용량 xlsx**: 100MB↑ 변환은 OnlyOffice `maxDownloadBytes`(local.json, oo-up.sh 영속화) 상향 필요. 시트가 너무 길어 page 분할되는 변신 파일은 미해결(텍스트 폴백).
- **8_Contents**: content.md 밀집 한글 테이블은 Vision OCR 잔노이즈 있음(구조·수치·ID는 정확).
- p4 client view = 7_System+8_Contents+Resource/design 3경로만(jacob-server). 티켓 12h → systemd ExecStartPre p4 login.
