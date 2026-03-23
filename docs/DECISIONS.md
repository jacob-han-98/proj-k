# Project K AI 어시스턴트 - 의사결정 히스토리

> 주요 기술/방향 의사결정을 시간순으로 기록한다.
> 형식: 날짜, 결정 사항, 배경/근거, 대안, 결과

---

## ADR-001: 변환 파이프라인 Tier 구조 채택

- **날짜**: 2026-02 (세션 1~2)
- **결정**: XLSX 변환을 3단계 Tier로 분리
  - Tier 1: openpyxl 셀 데이터
  - Tier 1.5: OOXML 도형/플로우차트 직접 파싱
  - Tier 2: Vision API로 이미지 분석
- **근거**: 엑셀 기획서의 정보 80%+가 셀 외부(도형, 이미지)에 존재. openpyxl만으로는 부족.
- **대안 검토**:
  - 전체 스크린샷 → Vision API: 비용 높고, 표 구조 해석 부정확
  - 수동 변환: 104개 × 10시트 = 비현실적
- **결과**: Tier 1+1.5로 도형 327/327 추출, 연결선 123/123 매핑 달성

## ADR-002: 도형 표현 형식 - YAML + Mermaid 하이브리드

- **날짜**: 2026-02 (세션 3)
- **결정**: 도형 데이터를 YAML(AI용) + Mermaid(시각화용) 이중 출력
- **근거**: ASCII 아트는 AI 파싱 어렵고, PlantUML은 렌더링 환경 제한적
- **대안**: ASCII 아트 (파싱 난이도), PlantUML (의존성), JSON (가독성)
- **결과**: AI 파싱 정확도 + 사람 시각 확인 모두 충족

## ADR-003: Vision 보강 시스템 도입

- **날짜**: 2026-03 (세션 7~9)
- **결정**: Bedrock Vision API로 이미지 내 텍스트 자동 분석
- **근거**: Tier 2 이미지 한계로 4/35 검증 항목 FAIL
- **기술**: AWS Bedrock Claude 3.5 Sonnet, 자동 분석 + MD 적용
- **결과**: 75개 이미지 마커 중 24개(32%) 자동 설명 완료

## ADR-004: 프로젝트 방향 전환 - 변환 도구 → AI 에이전트

- **날짜**: 2026-03-06 (세션 10)
- **결정**: 단순 문서 변환 프로젝트에서 4단계 AI 기획 어시스턴트 프로젝트로 확장
- **근거**:
  - 변환 자체는 수단이지 목적이 아님
  - 최종 가치는 AI가 기획 지식을 활용하여 기획자를 돕는 것
  - 변환(1단계)은 그대로 유지하되, 상위 목표를 명확히 함
- **4단계 로드맵**:
  1. 지식화 (기존 변환 작업 계속)
  2. QnA API (Backend + RAG)
  3. 기획 리뷰 (충돌/누락 감지)
  4. 실시간 어시스턴트 (Confluence/Excel 모니터링)
- **변경 사항**:
  - CLAUDE.md 전면 개편
  - docs/ 폴더 신설 (VISION, ARCHITECTURE, DECISIONS, MEMORY)
  - 기존 claude_memory.md → docs/MEMORY.md로 이관

## ADR-005: 변환 순서 전환 - Vision-First 방식

- **날짜**: 2026-03-06 (세션 10)
- **결정**: 변환 순서를 역전시킴
  - 기존: Excel 파싱(openpyxl) → MD → Vision API 보정
  - **신규: Vision API 먼저 (스크린샷→AI 분석) → Excel 데이터로 보강**
- **근거**:
  - 기존 방식의 한계: openpyxl이 읽지 못하는 도형/이미지가 정보의 80%+
  - Vision API가 전체 레이아웃/도형/플로우차트/이미지 텍스트를 한번에 인식
  - Excel 데이터 파싱은 Vision이 약한 부분(정확한 수치, 숨겨진 셀, 수식)만 보강
  - 더 자연스러운 흐름: "전체 그림 먼저 → 세부 수치 보강"
- **추가 결정**:
  - 원본 소스: 임시 복사본 → Perforce/Confluence 실시간 동기화
  - 서버 환경: headless로 스크린샷 캡처 필요
- **영향**:
  - 기존 convert_xlsx.py (Tier 1+1.5) → 보강용으로 역할 변경
  - 새 파이프라인 설계 필요 (스크린샷 캡처 → Vision → 데이터 보강 → 합성)
  - ADR-001의 Tier 구조가 사실상 역전됨

## ADR-006: Vision-First 파이프라인 구현 결정

- **날짜**: 2026-03-07 (세션 11)
- **결정**: Vision-First 파이프라인 v1 구현 완료
- **기술 선택**:
  - 스크린샷: LibreOffice 26.2.0 headless (Excel COM 대신, 서버 호환성 우선)
  - Vision 모델: Claude Opus via AWS Bedrock
  - 시트 격리: 시트당 별도 LibreOffice 프로세스 (UNO 크래시 방지)
  - 환경변수: `ConvertProgram/.env` 파일에서 python-dotenv로 로드
- **검증 결과** (PK_단축키 시스템):
  - 2/3 시트 변환 성공 (히스토리, HUD)
  - 게임 UI 스크린샷 내 텍스트/숫자 정확히 인식
  - 26개 단축키 매핑을 완벽한 테이블로 구조화
  - 소요시간: ~120초/파일 (3시트, Vision API 포함)
- **알려진 이슈**:
  - LibreOffice 3번째 연속 프로세스 간헐적 크래시 → 재시도 로직 추가
- **파일**:
  - `ConvertProgram/_tools/lo_sheet_export.py` - 시트별 PDF 내보내기
  - `ConvertProgram/_tools/vision_first_convert.py` - 메인 파이프라인

## ADR-007: Stage 3 — Vision AI 기본 신뢰 + OOXML 커넥터 검증 전략

- **날짜**: 2026-03-08
- **결정**: Vision AI 결과를 기본으로 신뢰하되, OOXML 파싱 데이터로 교정하는 하이브리드 전략 채택
- **근거 (실험 결과)**:
  - Vision AI가 플로우차트의 긴 수평 연결선을 추적하지 못하는 구조적 약점 발견
  - 변신 시트 합성 플로차트: "합성 진행불가 → 종료" 연결을 3회 프롬프트 반복으로도 실패
  - OOXML `xl/drawings/drawingN.xml`에서 커넥터 start/end shape ID를 추출 → 해당 연결(id=39→id=34) 100% 정확 추출
  - 도형 내 텍스트도 OOXML에서 직접 추출 가능 (Vision 오독 "적용 스펙 수" ← 실제 "적용 스탯 수")
- **우선 소스 규칙**:
  | 데이터 유형 | 우선 소스 | 이유 |
  |-------------|-----------|------|
  | 레이아웃/구조 | Vision AI | 시각적 배치를 AI가 가장 잘 이해 |
  | 커넥터/화살표 | OOXML | Vision의 구조적 약점 |
  | 도형 텍스트 | OOXML | 해상도 제한으로 오독 가능성 |
  | 숨겨진 데이터/수식 | openpyxl | Vision이 볼 수 없는 정보 |
- **대안 검토**:
  - 프롬프트만으로 해결: 3회 반복 실패, 구조적 한계
  - OOXML만으로: 레이아웃/맥락 해석은 Vision이 월등
  - 2-pass Vision: 추가 API 비용 + 여전히 불확실
- **결과**: SPEC.md 6장 Stage 3에 상세 스펙 반영

## ADR-008: QnA PoC 우선 진행, 데이터 확장은 병행

- **날짜**: 2026-03-08
- **결정**: xlsx-extractor 전체 변환 완료 후, Confluence PDF 변환보다 **QnA PoC를 먼저** 진행
- **근거**:
  1. **핵심 데이터는 이미 확보**: 7_System 67파일 포함 104파일, 623시트 변환 완료 (98.1%)
  2. **가치 증명이 급선무**: 변환만으로는 프로젝트 가치를 보여줄 수 없음. QnA 데모가 피칭 자료로 직결
  3. **커버리지 검증 효과**: QnA PoC를 돌려보면 "어떤 질문에 답 못하는지" → Confluence 등 추가 데이터의 실제 필요성 판단 가능
  4. **Confluence PDF 296개는 보조 자료 비중 높음**: 회의록, 정책 문서 등. 시스템 기획서(핵심)는 Excel에 있음
- **데이터 확장 전략**:
  - QnA PoC와 **병행하여** 필요 시 데이터 소스 추가
  - 우선순위: Excel 추가 기획서 → Confluence PDF (선별) → PPTX
  - QnA 결과에서 답변 불가 영역 분석 → 해당 영역의 데이터를 우선 확장
- **대안 검토**:
  - Confluence 먼저: 지식 베이스 완성도는 높아지지만, 가치 증명이 늦어짐
  - 전체 완료 후 QnA: 296 PDF 변환에 추가 시간 소요, 그동안 프로젝트 모멘텀 상실 리스크
- **영향**:
  - VISION.md 로드맵 1단계 → "Excel 변환 완료, 추가 소스는 확장 트랙"으로 변경
  - 2단계(QnA PoC) 즉시 착수

## ADR-009: 데이터 확장 & 동기화를 독립 단계(3단계)로 분리

- **날짜**: 2026-03-08
- **결정**: 기존 2단계(QnA)와 3단계(기획 리뷰) 사이에 **데이터 확장 & 동기화** 단계를 신설
  - 기존 3~7단계 → 4~8단계로 번호 재배정
- **근거**:
  1. **기획 리뷰(4단계)는 완전한 데이터셋이 전제**: 불완전한 데이터로 충돌/누락 감지 시 오탐·미탐 발생
  2. **Confluence에 의사결정 맥락 존재**: 기획서의 "왜"를 이해하려면 Confluence PDF 변환 필수
  3. **Perforce 동기화 없으면 구 버전 리뷰 위험**: 기획서가 이미 수정되었는데 구 버전으로 리뷰하는 사태 방지
  4. **QnA PoC 결과가 우선순위 결정에 활용됨**: 2단계에서 답변 불가 영역 → 3단계에서 해당 데이터 우선 변환
- **범위**:
  - Confluence PDF 296개 변환 (Vision-First 파이프라인 적용)
  - PPTX 11개 변환 완료
  - Perforce 원본 자동 동기화 + 변경 감지 → 자동 재변환
  - Knowledge Graph 확장 + ChromaDB 인덱스 갱신
  - 데이터 커버리지 맵 자동 생성
- **기존 5단계(사내 서비스)와의 차이**:
  - 3단계: 데이터 **완전성과 신선도** 확보 (PoC 수준)
  - 6단계(구 5단계): 프로덕션 수준 인프라, 무중단 동기화, 모니터링
- **영향**:
  - VISION.md 전체 단계 번호 재배정
  - CLAUDE.md 단계 테이블 업데이트
  - 기존 ADR에서 단계 번호 참조는 문맥으로 이해 가능 (당시 기준 번호)

## ADR-010: Confluence PDF 변환 대신 REST API 직접 추출

- **날짜**: 2026-03-09
- **결정**: Confluence 데이터를 PDF 경유 변환(Vision-First) 대신 **REST API에서 Storage Format을 직접 Markdown으로 변환**
- **근거**:
  1. **PDF는 중간 손실 매체**: Confluence → PDF 내보내기 과정에서 레이아웃/매크로/이미지 품질 저하
  2. **Storage Format이 구조화된 원본**: HTML/XML 기반이므로 직접 파싱이 더 정확하고 저비용
  3. **Vision API 불필요**: PDF → 스크린샷 → Vision API 파이프라인 대비 비용 0, 속도 수십 배 빠름
  4. **이미지 원본 확보**: 첨부 파일 API로 원본 해상도 이미지 직접 다운로드 가능
  5. **페이지 수 증가**: 기존 PDF 296개 → REST API로 490페이지 발견 (folder 타입 포함)
- **기술 선택**:
  - API: Confluence REST API v1 + CQL (`parent={id}`로 재귀 탐색)
  - 인증: Basic Auth (email + API token)
  - 변환: BeautifulSoup (Confluence XML 전처리) + markdownify (HTML → Markdown)
  - 재시도: 지수 백오프 (503 서버 에러 대응)
- **결과**:
  - 490페이지 전체 다운로드, 489개 content.md, ~2,195 이미지, 8.2GB
  - 도구: `packages/confluence-downloader/`
  - `Confluence PDF Sync/` 폴더의 PDF 296개는 더 이상 변환 대상이 아님
- **대안 검토**:
  - PDF → Vision-First: 비용 높고 (Vision API), 품질 열화 (PDF 중간 변환), 속도 느림
  - Confluence API v2: folder 타입 API가 불안정하여 v1 + CQL 조합이 더 신뢰성 높음
- **영향**:
  - VISION.md 3단계 3-1항 업데이트 (PDF 변환 → REST API 직접 추출)
  - CLAUDE.md 원본 문서 현황 테이블 업데이트
  - 기존 `Confluence PDF Sync/` 폴더는 레거시로 분류

## ADR-011: Perforce 7_System 단독 동기화 + 외부 경로 운영

- **날짜**: 2026-03-09
- **결정**:
  1. Perforce 동기화 대상은 **7_System만** (Design 하위 다른 폴더는 미사용)
  2. 동기화 경로는 프로젝트 외부(`D:/ProjectK/Design/7_System`)
  3. xlsx-extractor는 `XLSX_SOURCE_DIRS` 환경변수로 외부 경로를 바라봄
  4. `--changed-only` 플래그로 변경된 Excel만 증분 변환
- **근거**:
  - Design 하위에 8개 폴더(334파일)가 있으나, AI 기획 어시스턴트가 활용하는 핵심 기획서는 7_System(69파일)뿐
  - 6_TableStructure(81), 8_Contents(82) 등은 데이터 테이블이라 기획 QnA 대상 아님
  - 프로젝트 git 레포에 대용량 바이너리(xlsx)를 넣지 않기 위해 외부 경로 사용
- **영향**:
  - `scripts/.env` — P4_DEPOT_PATH, P4_LOCAL_PATH 설정
  - `packages/xlsx-extractor/.env` — XLSX_SOURCE_DIRS 설정
  - `scripts/update_sources.py` — Perforce 동기화 함수 (외부 경로 지원)
  - `packages/xlsx-extractor/run.py` — `--changed-only`, `XLSX_SOURCE_DIRS` 지원

## ADR-013: QnA UX — Streamlit 개발 테스트 + Slack 봇 테스터 배포

- **날짜**: 2026-03-11
- **결정**: QnA PoC의 UX 전략을 2단계로 확정
  1. **Streamlit 웹앱**: 개발·품질 검증용 1차 인터페이스 (ChatGPT 스타일 대화 UI)
  2. **Slack 봇**: 일부 기획자 테스터 대상 배포 (Slack Bolt + 기존 agent.py 연결)
  3. 두 인터페이스는 동일한 Backend API(agent.py 파이프라인)를 공유
  4. 피칭 성공 후 6단계에서 Next.js 프로덕션 웹앱으로 전환, Slack 봇은 유지
- **근거**:
  1. **Streamlit이 개발 테스트에 최적**: Python 백엔드와 동일 언어, `st.chat_message`로 ChatGPT 스타일 UI를 1-2일 내 구현 가능. Markdown/표/Mermaid 풀 렌더링 지원
  2. **Slack이 테스터 배포에 최적**: 기획자가 이미 매일 사용, 설치/교육 불필요, 멘션 한 번으로 질문 가능
  3. **진입장벽**: 새 URL 접속(Streamlit) vs 슬랙 멘션(Slack) → 테스터 입장에서 Slack이 압도적으로 낮음
  4. **자연스러운 바이럴**: Slack 채널에 질문/답변이 공유되어 팀 학습 효과 + 피드백 수집 용이
  5. **표현력 한계 보완**: Slack에서 표/다이어그램이 필요한 긴 답변은 Streamlit 링크로 해결
- **대안 검토**:
  - Claude Web MCP 통합: 기술적으로 가능하나, 전 테스터 Claude Pro/Team 구독 + 개별 MCP 설정 필요 → 비현실적
  - Gemini 통합: 커스텀 지식베이스 연동 공식 지원 없음 → 불가
  - Next.js 웹앱: 프로덕션 품질이지만 개발 기간 1-2주+ → PoC 단계에서는 과도
  - Streamlit만: 테스터가 별도 URL을 방문해야 함 → 일상 업무 흐름에 자연스럽게 삽입되지 않음
- **영향**:
  - VISION.md 2-3절 UX 전략 업데이트
  - `packages/qna-poc/` 내 Streamlit UI + Slack 봇 구현 추가 예정

---

## ADR-012: 대규모 QnA 검증 (500개) — 데이터 확장 후 자동 평가

- **날짜**: 2026-03-09
- **결정**: 3단계 데이터 확장 완료 후 **500개 QnA로 대규모 자동 검증** 실시
- **방법**:
  1. Claude가 가공된 Confluence + Excel 자료를 직접 읽어 질문지 생성
  2. 질문 구성: 단순 질문, 복합 질문, 가짜 질문(10%), 유의어·오타 포함
  3. QnA 시스템으로 전체 테스트 실행
  4. 결과를 파일로 정리하여 사람이 리뷰 가능하게 출력
- **근거**:
  - 이전 평가(48개)는 Excel 데이터만 대상 — Confluence 추가 후 재검증 필수
  - 유의어·오타 질문은 SYNONYMS 사전 및 검색 robustness 테스트
  - 가짜 질문은 할루시네이션 방지 능력 검증
- **출력물**:
  - `packages/qna-poc/eval/questions_500.json` — 500개 질문 + GT
  - `packages/qna-poc/eval/eval_results_500.json` — 테스트 결과
  - `packages/qna-poc/eval/eval_report_500.md` — 사람 리뷰용 요약 리포트

## ADR-014: Agent 파이프라인 + LLM-as-Judge 95% 달성

- **날짜**: 2026-03-12
- **결정**: 단순 RAG → Agent 4원칙 파이프라인으로 전환, LLM-as-Judge 8축 채점 체계 도입
- **근거**:
  1. **검색 정확도와 답변 정확도는 별개**: 검색기 97.2%인데 실제 답변 PASS는 47% (v2 기준선)
  2. **Planning이 핵심**: Sonnet이 167개 워크북 + KG 관계에서 올바른 문서를 지목해야 답변 품질 확보
  3. **Reflection으로 자체 보정**: Haiku가 답변 품질 검증 + 부족 시 스마트 재검색 → 경계 케이스 PASS 전환
  4. **트랩 가드레일 필수**: Rule #7 (A 시스템 ≠ A의 B 기능), Rule #9 (우선순위) 강화로 트랩 100%
- **Agent 파이프라인**:
  ```
  질문 → [Planning] Sonnet (질문 분석 + 워크북 선택 + KG 관계 참조)
       → [Search] 하이브리드 4레이어 (구조적 + KG + 벡터 + 풀텍스트)
       → [Answer] Sonnet (temp=0, 15 chunks, 7000 char/chunk, 9개 가드레일 규칙)
       → [Reflection] Haiku (자체 검증, 부족하면 1회 재검색)
       → 최종 답변 (confidence: high/medium/low/none)
  ```
- **Judge 8축 채점**: intent_alignment, factual_accuracy, completeness, no_misinterpretation, source_fidelity, actionability, scope_match, freshness + bonus(implicit_prerequisites)
- **판정**: PASS(avg>=4.0 AND min>=3), PARTIAL(avg>=3.0 AND min>=2), FAIL
- **결과**: 15차 평가 기준 **95.0% (66/69)** — 일반 57/60 + 트랩 9/9
- **비용**: 평가 15회 + 인덱싱 다수 ≈ ~$50
- **영향**:
  - `src/agent.py` 신규 (Agent 파이프라인 전체)
  - `src/api.py` v0.2.0 (Agent 연결 + CORS)
  - `eval/verify_gt_llm.py` (Judge 채점 + 병렬 실행)
  - `eval/generate_gt_llm.py` (v2 질문 세트 69개)
  - `docs/AGENT_DESIGN.md`, `docs/UX_DEV_GUIDE.md` 신규

---

## ADR-015: 프론트엔드 전환 — Streamlit → React(Vite) SPA

- **날짜**: 2026-03-19
- **결정**: ADR-013의 Streamlit 1차 인터페이스를 건너뛰고, React + Vite SPA로 프론트엔드 직접 구축
- **변경 전 (ADR-013 계획)**:
  1. Streamlit 웹앱 (개발·검증용)
  2. Slack 봇 (테스터 배포)
  3. 피칭 성공 후 Next.js 프로덕션 전환
- **변경 후 (실제 진행)**:
  1. ~~Streamlit~~ → **React + Vite SPA** (개발·검증·데모용)
  2. Slack 봇 (테스터 배포, 유지)
  3. 피칭 성공 후 Next.js 전환 (React 컴포넌트 재사용)
- **근거**:
  1. **Streamlit의 구조적 한계**: Python 스크립트를 매번 위→아래 re-run하는 실행 모델이라, 멀티 스레드 대화 관리·localStorage 히스토리·SSE 스트리밍 같은 인터랙티브 기능 구현에 해킹스러운 우회가 필요
  2. **Mermaid 렌더링 문제**: Streamlit의 iframe 격리 환경에서 Mermaid 다이어그램의 height 처리, 배경색 제어 등에 지속적 이슈 발생
  3. **버릴 코드 최소화**: Streamlit UI는 6단계 Next.js 전환 시 전면 폐기 대상. 반면 React 컴포넌트는 Next.js로 거의 그대로 이관 가능 → 동일 시간을 투자하면 React가 자산으로 남음
  4. **FastAPI 백엔드 준비 완료**: api.py v0.2.0이 SSE 스트리밍·CORS·대화 관리를 이미 지원하므로, 프론트엔드만 붙이면 되는 상황
  5. **PoC 수준에 Vite가 적합**: Next.js의 SSR/라우팅/미들웨어는 현재 불필요. Vite + React의 경량 구성이 빠른 개발에 최적
- **기술 스택**:
  - React 19 + TypeScript + Vite 8
  - react-markdown + remark-gfm (Markdown 렌더링)
  - mermaid (다이어그램 렌더링)
  - SSE (EventSource) → FastAPI StreamingResponse 연결
  - localStorage 기반 대화 히스토리 (서버 저장 불필요)
- **현재 상태**: 단일 파일 SPA (App.tsx ~320줄). PoC로 충분하며, 기능 확장 시 컴포넌트 분리 예정
- **Next.js 전환 경로**: React 컴포넌트·CSS·API 호출 코드를 거의 그대로 가져갈 수 있어 마이그레이션 비용 낮음
- **영향**:
  - `packages/frontend/` 신규 (Vite + React SPA)
  - ADR-013의 3단계 UX 전략이 사실상 2단계로 단순화

## ADR-016: 기획서 수정 UX — Excel은 Cowork, Confluence는 크롬 확장

- **날짜**: 2026-03-20
- **결정**: AI가 제안한 기획서 변경을 실제 적용하는 UX를 플랫폼별로 분리
  - **Excel 기획서**: Claude Cowork를 통해 수정
  - **Confluence 기획서**: 크롬 확장(사이드 패널)을 통해 수정
  - **신규 기획서**: Confluence에 직접 페이지 생성 (REST API)
- **배경**:
  - QnA Agent가 대화 기반으로 기획서 수정/생성 제안을 생성하는 기능(Proposal) 구현 완료
  - 그러나 "제안 확인 → 실제 파일에 적용" 단계의 UX가 미결 상태
  - 시스템 기획자(전형재)와 직접 협의하여 결정
- **검토한 대안**:
  1. **웹에서 직접 수정**: Excel을 웹으로 수정하면 "엑셀 자체 본연의 기능이 얼마나 망가질지 예측이 안 됨" → 기각
  2. **별도 윈도우 앱(k-agent)**: 가능하나 PoC 단계에서 과도한 투자 → 향후 검토
  3. **openpyxl 프로그래밍 수정**: 셀 값 교체는 서식 유지되지만, 기획자가 복붙 노동을 하는 것은 지양 → 기각
  4. **Cowork 내보내기 + 크롬 확장**: 기획자의 실제 작업 환경에 자연스럽게 통합 → **채택**
- **근거** (시스템 기획자 피드백):
  1. "**컨플에서 작업하는 기획자에겐 브라우저 오른쪽에 달려있는 게 제일 나을 것**" — 크롬 확장의 사이드 패널이 자연스러움
  2. "**엑셀은 웹으로 가면 본연의 기능이 망가질 수 있어서** Claude Cowork로 가는 것이 좋을 것" — 로컬 파일 조작은 Cowork가 적합
  3. "**꼭 agent 사용 안 해도 Claude Cowork의 기능만으로도 엑셀을 요리할 수 있으니**" — 별도 앱 불필요
  4. "**엑셀 = Cowork, 컨플 = 크롬 확장**이 일관성 있을 것" — 플랫폼별 최적 도구 선택
- **구현 로드맵**:

  | 단계 | Excel | Confluence | 신규 기획서 |
  |------|-------|------------|-----------|
  | **PoC (현재)** | Cowork용 MD 내보내기 ✅ | 웹에서 제안 확인 | 웹에서 Markdown 미리보기 |
  | **피칭 후** | Cowork 연동 강화 | 크롬 확장 개발 (사이드 패널) | Confluence API로 페이지 자동 생성 |
  | **사내 서비스** | Cowork + Perforce 워크플로우 | 크롬 확장 + REST API 자동 적용 | 자동 생성 + 리뷰 워크플로우 |

- **현재 구현 상태**:
  - Agent Proposal 파이프라인: 대화 맥락 기반 수정/생성 제안 생성 ✅
  - ProposalView: 수정 diff(before/after) + 신규 문서 미리보기 카드 UI ✅
  - Cowork 내보내기: 대화 맥락 + 제안 + 실행 가이드 MD 다운로드 ✅
  - 대화 Fork: Admin에서 기존 대화를 복제하여 이어서 테스트 ✅
- **영향**:
  - 5단계(실시간 어시스턴트)의 UX 방향이 구체화됨
  - 크롬 확장은 5단계의 핵심 인터페이스가 될 가능성 높음
  - Claude Cowork 연동은 "AI가 실제 파일을 수정하는" 워크플로우의 첫 사례

## ADR-017: 파이프라인 프레임워크 — 자체 DAG 확장 (Dagster/Prefect 미채택)

- **날짜**: 2026-03-23
- **결정**: 현재 `packages/data-pipeline/` 패키지를 확장하여 선언적 DAG 프레임워크로 발전. 외부 프레임워크(Dagster, Prefect, Airflow) 도입하지 않음.
- **배경**:
  - 각 공정(Excel 변환, Confluence 다운로드, 인덱싱 등)을 PoC 방식으로 개별 구축해왔으나, 통합 파이프라인으로 정리 필요
  - 소스 변경 감지 → DAG 기반 후속 작업 자동 트리거, dev/prod 모드 분리, Admin 모니터링 필요
  - 전체 프로세스의 공학적 명칭: **Data Pipeline** — ETL의 확장 (비정형 문서 → AI 변환 → 구조화 지식)
- **현재 완성도**: 약 70%
  - DB 7테이블, 워커 6핸들러, 스케줄러, CLI, remote_db(Win↔Linux 분산), API 30개, Admin UI 5탭
  - 부족: (a) 선언적 DAG 정의 (b) 체이닝 일반화 (c) dev/prod 모드 분리
- **추가 구현 계획**:
  1. `config/pipelines.yaml` — 선언적 DAG 정의 (소스 타입별 Stage 그래프)
  2. `src/dag.py` — DAG 엔진 (pipelines.yaml 로드, 체이닝 로직)
  3. `src/mode.py` + `config/mode.yaml` — dev/prod 모드 관리
  4. debounced index 배치 트리거 (scheduler 확장)
  5. Admin UI DAG 시각화 탭
- **근거 (외부 프레임워크 미채택)**:
  1. 이미 70% 완성 — 새로 시작하면 기존 코드 폐기
  2. 1인 개발, 소스 2-5개, 문서 ~600개 규모에 Dagster/Prefect는 과도 (PostgreSQL + 데몬 인프라)
  3. Windows(P4+Excel COM) + Linux 분산이 이미 remote_db.py로 구현됨
  4. 부족한 부분이 명확하고 적음 (DAG 엔진 ~150줄, 모드 관리 ~80줄)
- **대안 검토**:
  - Dagster: 강력한 UI(Dagit) + Asset 의존성 네이티브 지원. 그러나 PostgreSQL 필수, 학습 곡선, 기존 코드 @asset 래핑 필요
  - Prefect: 데코레이터 기반으로 학습 쉬움. 그러나 Prefect Server 인프라, 분산 Agent 구성 추가 작업
  - Airflow: 엔터프라이즈급 DAG 오케스트레이터. 1인 프로젝트에 명백히 과도
- **향후 마이그레이션**: 6단계(사내 서비스)에서 규모 증가 시 Dagster 검토 가능. 현재 핸들러가 순수 함수에 가까워 `@asset` 래핑 비용 낮음.
- **상세 설계**: `packages/data-pipeline/docs/PIPELINE_DESIGN.md`
- **영향**:
  - ARCHITECTURE.md Data Pipeline 섹션 추가
  - 구현 로드맵 4단계 (Phase 0~3)
