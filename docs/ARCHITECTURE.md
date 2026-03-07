# Project K AI 어시스턴트 - 기술 아키텍처

## 전체 시스템 구조

```
[원본 소스]              [변환 파이프라인]           [지식 베이스]          [AI 서비스]
Perforce (Excel)    ──→  Vision-First Pipeline  ──→  _knowledge_base/  ──→  Agent API
Confluence (PDF)    ──→  (스크린샷→Vision→보강)       + Vector DB             |
  │                                                  + Knowledge Graph       v
  └─ 변경 감지 → 자동 재변환                                            [사용자 인터페이스]
                                                                        QnA / Review / Live
```

## 1단계: 지식화 아키텍처

### 원본 소스 동기화

```
[현재] 로컬 폴더 (임시 복사본, 검증용)
  ├─ 1_High_Concept/, 7_System/, 9_MileStone/ ... (Perforce에서 복사)
  └─ Confluence PDF Sync/ (Confluence에서 내보내기)

[향후] 실시간 동기화
  ├─ Perforce triggers → Excel 변경 감지 → 자동 재변환
  └─ Confluence webhook/polling → PDF 변경 감지 → 자동 재변환
```

### 변환 파이프라인 - Vision-First

```
원본 문서 (XLSX / PDF / PPTX)
  │
  ├─ [1차] Headless 스크린샷 캡처
  │         └─ LibreOffice headless / PDF renderer
  │              └─ 시트별/페이지별/슬라이드별 PNG
  │
  ├─ [2차] Vision API 분석 (주 변환)
  │         └─ 스크린샷 → Claude Vision API
  │              └─ 구조화된 Markdown 생성
  │              └─ 잘 읽는 것: 레이아웃, 도형, 플로우차트, 이미지 내 텍스트
  │
  ├─ [3차] 데이터 파싱 보강 (보조)
  │         └─ openpyxl (XLSX) / PyMuPDF (PDF) / python-pptx (PPTX)
  │              └─ Vision이 약한 것: 정확한 수치, 숨겨진 셀, 수식, 데이터 테이블
  │
  └─ [합성] 두 결과 병합 → 최종 Markdown
                    │
                    v
            _knowledge_base/  (구조화된 지식)
```

### 레거시 파이프라인 (참고용, 기존 완성)

```
원본 문서
  ├─ XLSX ──→ convert_xlsx.py ──→ Tier1(셀) + Tier1.5(도형) + Tier2(Vision보정)
  ├─ PDF  ──→ convert_pdf.py  ──→ 텍스트 추출 (Confluence 특화)
  └─ PPTX ──→ convert_pptx.py ──→ 슬라이드/테이블/노트
```

### 지식 구조화 (TODO)

```
_knowledge_base/
  ├─ sheets/{시스템명}/          # 시스템별 변환 결과
  ├─ pdf/{카테고리}/             # PDF 변환 결과
  ├─ index/                      # 검색 인덱스
  │   ├─ system_index.json       # 시스템별 문서 매핑
  │   ├─ term_dictionary.json    # 용어 사전
  │   └─ chunk_manifest.json     # RAG 청크 목록
  ├─ knowledge_graph.json        # 시스템 간 관계
  └─ PROJECT_K_KNOWLEDGE_BASE.md # 통합 요약
```

### 청크 전략 (RAG 준비)
- **단위**: 시트 > 섹션(H1/H2 기준) > 테이블/플로우차트
- **메타데이터**: 시스템명, 시트명, 섹션 경로, 관련 시스템 태그
- **크기**: 500~2000 토큰 / 청크 (Claude 기준)
- **오버랩**: 앞뒤 1문단 겹침으로 문맥 보존

---

## 2단계: QnA API 아키텍처 (초안)

```
사용자 질문
    │
    v
[Query Router]  ──→  키워드/시스템명 감지
    │
    ├─→ [Vector Search]  ──→  임베딩 유사도 검색
    ├─→ [Graph Search]   ──→  관련 시스템 탐색
    └─→ [Term Lookup]    ──→  용어 사전 매칭
    │
    v
[Context Assembly]  ──→  검색 결과 + 관련 문서 조합
    │
    v
[Claude API]  ──→  답변 생성 (출처 표시)
    │
    v
사용자 응답 (답변 + 출처 링크)
```

### 주요 컴포넌트

| 컴포넌트 | 역할 | 기술 후보 |
|----------|------|----------|
| Query Router | 질문 분류 + 검색 전략 결정 | 규칙 기반 + LLM 분류 |
| Vector Search | 의미 기반 문서 검색 | Chroma(로컬) or Pinecone |
| Graph Search | 시스템 관계 기반 탐색 | NetworkX + knowledge_graph.json |
| Context Assembly | 검색 결과 → 프롬프트 구성 | 토큰 예산 내 최적 조합 |
| Claude API | 답변 생성 | claude-sonnet (빠른 응답) / claude-opus (복잡한 분석) |

---

## 3단계: 리뷰 시스템 (초안)

```
[기존 기획 분석]
  전체 지식 베이스 → 교차 검증 → 충돌/누락 리포트

[신규 기획서 리뷰]
  업로드된 문서 → 기존 지식과 비교 → 정합성 리포트
```

---

## 4단계: 실시간 어시스턴트 (초안)

```
[Confluence/Excel 변경 감지]
    │
    v
[변경 내용 파싱]  ──→  작성 중인 기획 내용 추출
    │
    v
[컨텍스트 매칭]   ──→  관련 기존 기획 검색
    │
    v
[피드백 생성]     ──→  Claude API로 의견 생성
    │
    v
[사이드바 UI]     ──→  기획자에게 실시간 표시
```

---

## 의존성

### 현재 (1단계)
```
anthropic       # Claude Vision API (주 변환 엔진)
openpyxl        # XLSX 데이터 보강
pymupdf (fitz)  # PDF 데이터 보강
python-pptx     # PPTX 데이터 보강
```

### 1단계 추가 필요
```
# headless 스크린샷
libreoffice     # headless Excel/PPT → PDF/PNG 변환 (서버용)
# 또는 Windows 환경: Excel COM automation

# 원본 동기화 (향후)
p4python        # Perforce Python API
atlassian-python-api  # Confluence API
```

### 2단계 추가 예정
```
fastapi         # Backend API
chromadb        # 벡터 DB (또는 대안)
voyageai        # 임베딩 (또는 대안)
networkx        # 그래프 탐색
```

## 미결정 사항
- [ ] Headless 렌더링 방식 (LibreOffice vs Excel COM vs 클라우드 서비스)
- [ ] 벡터 DB 선택 (로컬 Chroma vs 클라우드 Pinecone)
- [ ] 임베딩 모델 선택 (Voyage AI vs OpenAI vs 오픈소스)
- [ ] 배포 환경 (로컬 개발 서버 vs AWS)
- [ ] 프론트엔드 프레임워크
- [ ] Confluence API 연동 방식 (webhook vs polling)
- [ ] Perforce 동기화 방식 (triggers vs polling)

> 미결정 사항은 각 단계 착수 시 결정하고 `docs/DECISIONS.md`에 기록
