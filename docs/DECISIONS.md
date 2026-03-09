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
