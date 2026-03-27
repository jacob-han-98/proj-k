# 캡처 단계 개선 백로그 (후순위 — 피칭 후 작업)

> 작성일: 2026-03-27
> 우선순위: 피칭 후
> 관련: parse_ooxml.py, capture.py, synthesize.py

---

## 1. 플로우차트 도형/커넥터 정보 추출 (Excel COM)

### 문제

- Vision 모델이 플로우차트 화살표(특히 우회 연결선)를 정확히 읽지 못함
- OOXML에서 커넥터 endpoint의 도형 ID가 유실되는 경우가 있음 (orphan reference)
  - 예: id=319가 XML에 존재하지 않지만 커넥터가 참조 → 실제로는 id=347("인벤토리 체크")
- OOXML 좌표 계산은 그룹 중첩 + 셀 기반 상대좌표로 복잡하고 부정확

### 해결 방법

**캡처 단계(Excel COM)에서 모든 도형/커넥터의 상세 정보를 추출하여 JSON으로 저장:**

```
_vision_input/shapes_topology.json
```

#### 도형 정보
- `id`, `name`, `type` (msoAutoShape, msoGroup, msoConnector 등)
- `left`, `top`, `width`, `height` (points, 절대 좌표)
- `text` (도형 내 텍스트)
- `geom_type` (diamond, roundRect, ellipse 등)
- `group_id` (소속 그룹 ID, 없으면 null)

#### 커넥터 정보
- `id`, `name`
- `left`, `top`, `width`, `height` (바운딩 박스)
- `horizontal_flip`, `vertical_flip`
- `begin_shape`: 연결된 도형 ID (ConnectorFormat.BeginConnectedShape)
- `end_shape`: 연결된 도형 ID (ConnectorFormat.EndConnectedShape)
- `begin_pt`: [x, y] 시작점 좌표 (계산)
- `end_pt`: [x, y] 끝점 좌표 (계산)
- `begin_connection_site`, `end_connection_site`: 연결점 인덱스

#### 끊긴 커넥터 (orphan) 처리
- `EndConnectedShape` 접근 시 에러 → try/except로 감지
- 바운딩 박스 + flip 정보로 끝점 좌표 계산
- `end_shape: null`, `end_pt: [x, y]` 로 저장
- 합성 단계에서 `end_pt` 좌표에 가장 가까운 도형을 매핑

### 활용 (합성 단계)

1. Vision이 Mermaid 플로우차트를 생성
2. `shapes_topology.json`의 커넥터 연결 정보를 ground truth로 사용
3. Vision Mermaid의 화살표를 COM 데이터로 **검증/보정**
4. 끊긴 커넥터는 좌표 기반으로 가장 가까운 도형에 매핑

### 구현 위치

- `capture.py`: `phase1_capture_images()` 에서 CopyPicture 후 도형 추출 추가
- `synthesize.py`: 합성 단계에서 `shapes_topology.json` 로드 → Mermaid 보정

---

## 2. 캡처 영역 하단 잘림 문제

### 문제

- Excel COM `CopyPicture`로 캡처 시 하단이 잘리는 경우 발생
- 원인: UsedRange가 셀 데이터 기준이라, 도형이 셀 범위 밖으로 돌출된 경우 잘림
- 특히 플로우차트가 시트 하단에 배치된 경우 심함

### 해결 방법

캡처 영역 계산 시:
1. `UsedRange`로 셀 기반 범위 확보
2. **모든 도형의 `Top + Height` 최댓값** 계산 (COM의 Shape.Top + Shape.Height)
3. UsedRange 행 범위와 도형 최하단 중 더 큰 값으로 캡처 범위 결정

```python
# Pseudo-code
used_range_bottom = ws.UsedRange.Row + ws.UsedRange.Rows.Count
shape_bottom_row = max(
    (shape.Top + shape.Height) for shape in ws.Shapes
) → 행 번호로 변환

capture_bottom = max(used_range_bottom, shape_bottom_row)
```

### 구현 위치

- `capture.py`: `_capture_one_sheet()` 에서 캡처 범위 결정 로직 수정

---

## 관련 PoC 검증 결과 (2026-03-27)

### OOXML 그룹 텍스트 병합 (구현 완료)

- 소규모 그룹(≤3개 도형)의 TextBox 텍스트를 마름모/사각형에 병합
- 커넥터 텍스트 매핑: 1/29 → 25/29 (3% → 86%)

### orphan 참조 복구 (부분 해결)

- 보완적 이웃 패턴 + 같은 그룹 내 리다이렉트: id=319 → id=347 매핑 성공
- 하지만 휴리스틱 기반이라 모든 케이스 보장 불가
- **COM 기반 좌표 매핑으로 근본 해결 예정**

### 검증 파일

- `PK_보상 시스템/상자 아이템_기획` 시트로 검증
- 원본: `P:\Design\7_System\PK_보상 시스템.xlsx`
- 결과: `output/7_System/PK_보상 시스템/상자 아이템_기획/_parse_ooxml_output/`
  - `flowchart_ooxml.md` — OOXML 기반 Mermaid 플로우차트
  - `shapes.json`, `connectors.json` — 도형/커넥터 raw 데이터
