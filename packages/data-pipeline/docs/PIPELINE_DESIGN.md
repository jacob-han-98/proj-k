# Data Pipeline - 설계 문서

> 작성: 2026-03-23
> 상태: 설계 완료, 구현 대기

## 1. 개요

### 이 파이프라인은 무엇인가?

Project K의 Data Pipeline은 비정형 문서(Excel 기획서, Confluence 위키, PPTX)를 AI가 이해할 수 있는 구조화된 지식으로 변환하는 파이프라인이다. ETL 패턴을 따르되, Transform 단계에 Vision AI + LLM 해석이 포함된다.

```
E (Extract)   = crawl + download + capture     소스에서 원본 획득
T (Transform) = vision + parse + synthesize + enrich  AI 기반 비정형 변환
L (Load)      = index + kg_build               벡터DB + 지식 그래프 적재
```

### 용어 정리

| 용어 | 사용 맥락 |
|------|-----------|
| **Data Pipeline** | 프로젝트 전반, 코드/패키지명 (`packages/data-pipeline/`) |
| **파이프라인 단계 (Stage)** | DAG의 각 노드 (crawl, download, capture, convert, enrich, index, kg_build) |
| **파이프라인 정의 (Pipeline)** | 소스 타입별 Stage 연결 그래프 (예: confluence-enrich) |
| **작업 (Job)** | 특정 문서에 대한 특정 Stage 실행 단위 (DB jobs 테이블) |
| **핸들러 (Handler)** | 각 Stage의 실제 처리 함수 (`@register_handler`) |

---

## 2. 현재 상태 분석

### 이미 구축된 것 (약 70%)

| 컴포넌트 | 파일 | 상태 |
|----------|------|------|
| **DB 스키마** | `src/db.py` | 7 테이블 (crawl_sources, documents, conversions, jobs, issues, index_snapshots, crawl_logs) |
| **워커 프레임워크** | `src/worker.py` | 6 핸들러 (crawl, download, enrich, capture, convert, index) |
| **스케줄러** | `src/scheduler.py` | daily/hourly/weekly 자동 트리거 |
| **CLI** | `src/cli.py` | sources/docs/jobs/issues/pipeline 명령 |
| **원격 DB API** | `src/remote_db.py` | Windows↔Linux 분산 워커 지원 |
| **소스 설정** | `config/sources.yaml` | 2개 소스 (Perforce, Confluence) |
| **Admin UI** | `PipelinePage.tsx` | 5탭 (전체현황/소스/문서/작업큐/이슈) |
| **API 엔드포인트** | `api.py` | 파이프라인 CRUD 30개 |

### 부족한 것 (약 30%)

| 부족 영역 | 현재 상태 | 목표 |
|-----------|----------|------|
| **DAG 정의** | `_auto_chain_jobs()`에 하드코딩 (crawl→capture/download만) | 선언적 YAML로 전체 파이프라인 정의 |
| **체이닝 일반화** | crawl 핸들러에서만 체이닝 발생 | 모든 핸들러 완료 시 DAG 엔진이 다음 단계 결정 |
| **dev/prod 모드** | 없음 — 항상 같은 동작 | 개발(수동/안전) vs 서비스(자동/알림) |
| **배치 인덱싱** | 문서 단위 index 트리거 없음 | debounced 배치 트리거 |
| **DAG 시각화** | 없음 | Admin UI에서 파이프라인 그래프 + 상태 배지 |

---

## 3. DAG 설계

### 3-1. 소스 타입별 파이프라인 DAG

**Excel (Perforce)**:
```
crawl --> capture(win) --> convert(vision-first) --> index --> kg_build
```

**Confluence**:
```
crawl --> download --> enrich(조건: 이미지 있으면) --> index --> kg_build
                  \--> index (이미지 없으면) -----------/
```

**PPTX (향후)**:
```
crawl --> capture --> convert(vision-first) --> index --> kg_build
```

**DataSheet (향후)**:
```
crawl --> convert(table-parser) --> index --> kg_build
```

### 3-2. 선언적 DAG 정의: `config/pipelines.yaml`

```yaml
pipelines:
  excel-vision:
    description: "Excel Vision-First 파이프라인"
    source_types: [perforce]
    convert_strategy: vision-first
    stages:
      - name: crawl
        worker_type: any
        next: [capture]
      - name: capture
        worker_type: windows        # Excel COM CopyPicture는 Windows 전용
        next: [convert]
      - name: convert
        worker_type: any
        params:
          strategy: vision-first
        next: [index]
      - name: index
        worker_type: any
        batch: true          # 개별 문서가 아닌 배치 트리거
        next: [kg_build]
      - name: kg_build
        worker_type: any
        batch: true

  confluence-enrich:
    description: "Confluence HTML->MD + 이미지 보강 파이프라인"
    source_types: [confluence]
    convert_strategy: html-to-md
    stages:
      - name: crawl
        worker_type: any
        next: [download]
      - name: download
        worker_type: any
        next_if:
          has_images: [enrich]    # 이미지가 있는 문서 -> enrich
          default: [index]        # 이미지 없으면 바로 index
      - name: enrich
        worker_type: any
        next: [index]
      - name: index
        worker_type: any
        batch: true
        next: [kg_build]
      - name: kg_build
        worker_type: any
        batch: true

  excel-table:
    description: "데이터시트 테이블 파서 (향후)"
    source_types: [perforce]
    convert_strategy: table-parser
    stages:
      - name: crawl
        worker_type: windows
        next: [convert]
      - name: convert
        worker_type: any
        params:
          strategy: table-parser
        next: [index]
      - name: index
        worker_type: any
        batch: true
        next: [kg_build]
      - name: kg_build
        worker_type: any
        batch: true
```

### 3-3. DAG 엔진: `src/dag.py` (신규)

```python
class PipelineDAG:
    """선언적 YAML 기반 파이프라인 DAG 엔진.

    기존 _auto_chain_jobs()의 하드코딩을 대체한다.
    worker.py의 모든 핸들러 완료 시 이 엔진이 다음 단계를 결정한다.
    """

    def __init__(self, config_path: str = "config/pipelines.yaml"):
        self.pipelines = self._load(config_path)

    def resolve_pipeline(self, source: dict) -> str | None:
        """소스의 source_type + convert_strategy에 매칭되는 파이프라인명 반환."""
        # source_type과 convert_strategy로 매칭
        ...

    def get_next_stages(self, pipeline_name: str, current_stage: str,
                        context: dict = None) -> list[str]:
        """현재 단계 완료 후 다음 단계 목록 반환.

        context에 조건부 분기용 정보를 포함 (예: has_images=True).
        next_if가 있으면 context의 값으로 분기 결정.
        """
        ...

    def is_batch_stage(self, pipeline_name: str, stage_name: str) -> bool:
        """배치 단계인지 확인 (index, kg_build 등)."""
        ...

    def chain_next_jobs(self, pipeline_name: str, current_stage: str,
                        document_id: int, context: dict = None) -> int:
        """다음 단계 작업을 DB 큐에 등록.

        batch=true인 단계는 작업을 생성하지 않고, 문서 상태만 업데이트.
        scheduler가 주기적으로 배치 트리거.
        """
        ...

    def get_all_stages(self, pipeline_name: str) -> list[dict]:
        """파이프라인의 전체 단계 목록 (Admin UI DAG 시각화용)."""
        ...
```

### 3-4. worker.py 통합 방식

**변경 전** (현재):
```python
# handle_crawl() 내부에서만 체이닝
changed_docs = result.get("_changed_docs", [])
chained = _auto_chain_jobs(source, changed_docs)  # 하드코딩
```

**변경 후**:
```python
# Worker.run_once() 에서 모든 핸들러 완료 후 체이닝
result = handler(job, self.worker_id)

# DAG 엔진으로 다음 단계 결정
if dag and source:
    pipeline_name = dag.resolve_pipeline(source)
    if pipeline_name:
        chained = dag.chain_next_jobs(
            pipeline_name, job["job_type"],
            document_id=job.get("document_id"),
            context=result.get("_chain_context", {})
        )
```

- `_auto_chain_jobs()` 함수 삭제
- 각 핸들러는 `_chain_context`에 분기 조건 정보를 담아 반환 (예: `{"has_images": True}`)
- DAG 엔진이 pipelines.yaml을 보고 다음 단계 결정

### 3-5. index/kg_build 배치 처리

`batch: true`로 마킹된 단계는 문서 단위로 작업을 생성하지 않는다.

**흐름**:
1. download/enrich/convert 완료 → 문서 상태를 `ready_for_index`로 업데이트
2. scheduler가 주기적 확인: `ready_for_index` 상태 문서가 있는가?
3. 마지막 변경 후 `debounce_minutes` 경과 → index 배치 작업 1개 생성
4. index 완료 → kg_build 배치 작업 1개 생성

```
개별 문서 완료 -> documents.status = 'ready_for_index'
                       |
               scheduler 주기 확인 (5분)
               "ready_for_index 문서가 있고, 마지막 변경 후 N분 경과?"
                       | YES
               index 작업 1개 생성 (배치)
                       |
               kg_build 작업 1개 생성
```

---

## 4. 개발/서비스 모드 설계

### 4-1. 모드 설정: `config/mode.yaml`

```yaml
# 현재 활성 모드
mode: dev

dev:
  scheduler:
    enabled: false             # 수동 트리거만
    check_interval: 300        # 5분 (참고용)
  worker:
    poll_interval: 10          # 10초
    concurrent: 1              # 순차 처리
  index:
    debounce_minutes: 0        # 즉시 인덱싱 (테스트 편의)
    auto_trigger: false        # 수동 트리거만
  safety:
    dry_run_default: true      # CLI 기본이 --dry-run
    confirm_batch: true        # 전체 실행 시 확인 프롬프트
    max_documents_per_run: 10  # 최대 처리 문서 수 제한
  logging:
    level: DEBUG
    console: true

prod:
  scheduler:
    enabled: true              # 자동 트리거
    check_interval: 300        # 5분
  worker:
    poll_interval: 5           # 5초
    concurrent: 3              # 병렬 처리
  index:
    debounce_minutes: 5        # 변경 후 5분 대기
    auto_trigger: true         # 자동 인덱싱
  safety:
    dry_run_default: false
    confirm_batch: false
    max_documents_per_run: 0   # 무제한
  notifications:
    telegram: true             # 에러/완료 알림
    on_error: always
    on_complete: daily_summary
  logging:
    level: INFO
    console: false
    file: /var/log/data-pipeline/pipeline.log
```

### 4-2. 모드 관리: `src/mode.py` (신규)

```python
class PipelineMode:
    """dev/prod 모드 관리."""

    def __init__(self, config_path: str = "config/mode.yaml"):
        self.config = self._load(config_path)

    @property
    def current_mode(self) -> str:
        """현재 모드 (dev/prod). 환경변수 PIPELINE_MODE로 오버라이드 가능."""
        return os.getenv("PIPELINE_MODE", self.config.get("mode", "dev"))

    def get(self, key: str, default=None):
        """현재 모드의 설정값 조회. 점 표기법 지원 (예: 'safety.dry_run_default')."""
        ...

    def set_mode(self, mode: str):
        """모드 전환 (YAML 파일 업데이트)."""
        ...
```

### 4-3. dev 모드 전용 기능

```bash
# 단일 파일만 파이프라인 실행
python -m src.worker --trigger crawl --source-id 1 --single "PK_변신 및 스킬.xlsx"

# dry-run (실제 실행 없이 계획 출력)
python -m src.cli pipeline trigger 1 --dry-run

# 특정 단계만 실행
python -m src.worker --trigger convert --document-id 42 --stage-only

# 상세 로그
python -m src.worker --id dev --verbose
```

### 4-4. prod 모드 전용 기능

```bash
# systemd 서비스
systemctl start data-pipeline-worker
systemctl start data-pipeline-scheduler

# 에러 시 Telegram 알림
# 일일 요약 리포트 (처리 문서 수, 에러 수, 비용)
# 인덱스 자동 스냅샷 + 롤백 포인트
```

---

## 5. 구현 로드맵

### Phase 0: DAG 엔진 + 체이닝 일반화

**파일 변경**:
- `src/dag.py` 신규 (PipelineDAG 클래스, ~150줄)
- `config/pipelines.yaml` 신규 (위 설계대로)
- `src/worker.py` 수정:
  - `_auto_chain_jobs()` 제거
  - `Worker.__init__`에 DAG 엔진 초기화
  - `Worker.run_once()` 핸들러 완료 후 `dag.chain_next_jobs()` 호출
  - 각 핸들러가 `_chain_context` 반환하도록 수정

**검증**:
- Confluence crawl→download→enrich 체이닝이 DAG 기반으로 동일 동작
- 새 파이프라인 YAML 추가만으로 새 체이닝 패턴이 동작

### Phase 1: dev/prod 모드 분리

**파일 변경**:
- `src/mode.py` 신규 (PipelineMode 클래스, ~80줄)
- `config/mode.yaml` 신규 (위 설계대로)
- `src/cli.py` 수정: `mode set/get` 명령 추가
- `src/scheduler.py` 수정: 모드 연동 (dev: 비활성, prod: 자동)
- `src/worker.py` 수정: 모드별 concurrent, safety 설정 적용

**검증**:
- `python -m src.cli mode set dev` → scheduler 비활성 확인
- `python -m src.cli mode set prod` → scheduler 활성화 확인
- dev 모드에서 `max_documents_per_run` 초과 시 중단 확인

### Phase 2: debounced index 트리거

**파일 변경**:
- `src/db.py` 수정: `get_pending_index_docs()` 함수 추가
- `src/scheduler.py` 수정: `check_pending_index()` 함수 추가
- `src/worker.py` 수정: download/enrich/convert 핸들러가 완료 시 문서 상태를 `ready_for_index`로 변경

**검증**:
- 문서 enrich 완료 후 5분 대기 → 자동 index 작업 생성
- dev 모드에서는 debounce 없이 즉시 트리거 (debounce_minutes: 0)

### Phase 3: Admin UI DAG 시각화

**파일 변경**:
- `api.py` 수정: `GET /admin/pipeline/dag`, `GET /admin/pipeline/dag/{source_id}/status` 추가
- `PipelinePage.tsx` 수정: DAG 탭 추가
  - 소스별 파이프라인 시각화 (노드-엣지, CSS grid 또는 간단한 SVG)
  - 각 노드: 단계명 + 상태 배지(대기/진행/완료/실패) + 마지막 실행 시간
  - 노드 클릭: 해당 단계의 최근 작업 로그
  - 수동 트리거 버튼: 특정 단계만 재실행

**검증**:
- 브라우저에서 소스별 파이프라인 DAG 시각화 확인
- 수동 트리거로 특정 단계 실행 + 상태 업데이트 확인

### Phase 4: Webhook 트리거 (서비스 단계, 향후)

**파일 변경**:
- `api.py` 수정: `POST /webhook/confluence` 엔드포인트 추가
- Confluence Webhook 설정 가이드 문서

**검증**:
- Confluence 페이지 수정 → Webhook → crawl 자동 트리거

---

## 6. 파일 구조

```
packages/data-pipeline/
├── config/
│   ├── sources.yaml              # [기존] 크롤링 소스
│   ├── pipelines.yaml            # [신규] DAG 파이프라인 정의
│   └── mode.yaml                 # [신규] dev/prod 모드 설정
├── src/
│   ├── __init__.py               # [기존]
│   ├── db.py                     # [수정] pending index 조회 추가
│   ├── worker.py                 # [수정] _auto_chain_jobs → dag 교체
│   ├── scheduler.py              # [수정] debounced index + 모드 연동
│   ├── cli.py                    # [수정] mode/dag 명령 추가
│   ├── remote_db.py              # [기존] Windows→Linux API
│   ├── import_existing.py        # [기존] 데이터 임포트
│   ├── dag.py                    # [신규] DAG 엔진
│   └── mode.py                   # [신규] 모드 관리
├── docs/
│   └── PIPELINE_DESIGN.md        # 이 문서
└── requirements.txt              # [기존]
```

---

## 7. 프레임워크 선택 근거

### 왜 자체 확장인가? (Dagster/Prefect/Airflow 미채택)

| 요소 | 자체 확장 | Dagster/Prefect |
|------|----------|-----------------|
| 현재 완성도 | 70% (DB+워커+스케줄러+API+UI) | 0% (새로 시작) |
| 학습 비용 | 없음 | 중간 (개념 + 설정) |
| 인프라 추가 | 없음 | PostgreSQL + 데몬 |
| 1인 개발 적합성 | 최고 | 팀 협업 도구 성격 |
| Win+Linux 분산 | 이미 구현 (remote_db.py) | 추가 구성 필요 |
| 기존 코드 재사용 | 100% | 래핑 필요 |
| 프로젝트 규모 (소스 2-5, 문서 ~600) | 적절 | 과도 |

### 향후 마이그레이션 전략

6단계(사내 서비스)에서 파이프라인 규모가 커지면 Dagster 마이그레이션 검토 가능.
현재 핸들러가 순수 함수에 가까워 `@asset` 데코레이터로 래핑하는 비용이 낮다.

```python
# 현재 핸들러
@register_handler("download")
def handle_download(job, worker_id):
    ...

# Dagster 마이그레이션 시
@asset(deps=[crawl_asset])
def download_asset(context):
    handle_download(...)  # 기존 함수 재사용
```
