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
