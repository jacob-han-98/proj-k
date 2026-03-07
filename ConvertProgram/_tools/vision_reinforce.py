"""
vision_reinforce.py - Tier 2 Vision 보강 도구
===============================================
Tier 1.5에서 추출한 도형/플로우차트 데이터를 스크린샷과 대조하여 보강한다.

주요 보강 항목:
1. 고아 annotation 노드 → edge condition으로 전환
2. 누락된 edge 추가
3. 잘못된 edge 제거
4. 노드 타입 보정

사용법:
  python vision_reinforce.py <도형.yaml경로> <스크린샷경로> [--apply]
  python vision_reinforce.py --analyze <시트폴더>   # 폴더 내 전체 분석
  python vision_reinforce.py --apply-json <corrections.json> <도형.md경로>

워크플로:
  1) --analyze: 도형 데이터에서 보강 필요 항목 자동 감지 + AI 프롬프트 생성
  2) AI가 스크린샷을 보고 corrections.json 작성
  3) --apply-json: corrections를 _도형.md에 적용
"""

import json
import os
import sys
import re
import argparse
from pathlib import Path


def load_yaml_data(yaml_path):
    """간이 YAML 파서 - convert_xlsx.py가 생성한 _도형.yaml 파일 읽기"""
    nodes = []
    edges = []
    current_section = None
    current_item = None

    with open(yaml_path, 'r', encoding='utf-8') as f:
        for line in f:
            stripped = line.rstrip()
            # nodes: 또는 flowchart:\n  nodes: 형태 모두 지원
            if re.match(r'\s*nodes:\s*$', stripped):
                current_section = 'nodes'
                continue
            if re.match(r'\s*edges:\s*$', stripped):
                current_section = 'edges'
                continue
            if re.match(r'^(source|sheet|stats|flowchart):', stripped):
                if 'flowchart' not in stripped:
                    current_section = None
                continue
            if stripped.strip().startswith('shapes:') or stripped.strip().startswith('connectors:'):
                continue

            if current_section == 'nodes':
                m = re.match(r'\s+- id:\s*(.+)', stripped)
                if m:
                    current_item = {'id': m.group(1).strip()}
                    nodes.append(current_item)
                    continue
                m = re.match(r'\s+type:\s*(.+)', stripped)
                if m and current_item is not None:
                    current_item['type'] = m.group(1).strip()
                    continue
                m = re.match(r'\s+label:\s*"?(.+?)"?\s*$', stripped)
                if m and current_item is not None:
                    current_item['label'] = m.group(1).strip()
                    continue
                m = re.match(r'\s+geo:\s*(.+)', stripped)
                if m and current_item is not None:
                    current_item['geo'] = m.group(1).strip()

            elif current_section == 'edges':
                m = re.match(r'\s+- from:\s*(.+)', stripped)
                if m:
                    current_item = {'from': m.group(1).strip()}
                    edges.append(current_item)
                    continue
                m = re.match(r'\s+to:\s*(.+)', stripped)
                if m and current_item is not None:
                    val = m.group(1).strip()
                    if '#' in val:
                        val = val[:val.index('#')].strip()
                    current_item['to'] = val
                    continue
                m = re.match(r'\s+condition:\s*"?(.+?)"?\s*$', stripped)
                if m and current_item is not None:
                    current_item['condition'] = m.group(1).strip()

    return {'nodes': nodes, 'edges': edges}


def analyze_issues(data):
    """도형 데이터에서 보강 필요 항목을 자동 감지"""
    issues = []
    node_ids = {n['id'] for n in data['nodes']}
    edge_sources = {e['from'] for e in data['edges']}
    edge_targets = {e['to'] for e in data['edges']}
    connected_nodes = edge_sources | edge_targets

    # 1. 고아 annotation 노드 감지 (edge에 전혀 참여하지 않는 annotation)
    for node in data['nodes']:
        if node.get('type') == 'annotation' and node['id'] not in connected_nodes:
            issues.append({
                'type': 'orphan_annotation',
                'node_id': node['id'],
                'label': node.get('label', ''),
                'suggestion': 'edge_condition 또는 제거 대상. 스크린샷에서 이 텍스트가 화살표 위의 조건 라벨인지 확인 필요.'
            })

    # 2. annotation이 edge의 한쪽 끝에만 참여 (중간 라벨일 가능성)
    for node in data['nodes']:
        if node.get('type') != 'annotation':
            continue
        nid = node['id']
        as_source = [e for e in data['edges'] if e['from'] == nid]
        as_target = [e for e in data['edges'] if e['to'] == nid]
        if len(as_source) == 1 and len(as_target) == 0:
            issues.append({
                'type': 'annotation_source_only',
                'node_id': nid,
                'label': node.get('label', ''),
                'edge': f"{nid} → {as_source[0]['to']}",
                'suggestion': '이 annotation이 edge의 condition 라벨일 수 있음'
            })
        elif len(as_source) == 0 and len(as_target) == 1:
            issues.append({
                'type': 'annotation_target_only',
                'node_id': nid,
                'label': node.get('label', ''),
                'edge': f"{as_target[0]['from']} → {nid}",
                'suggestion': '이 annotation이 edge의 condition 라벨일 수 있음'
            })

    # 3. decision 노드의 분기 조건 누락 감지
    for node in data['nodes']:
        if node.get('type') != 'decision':
            continue
        outgoing = [e for e in data['edges'] if e['from'] == node['id']]
        if len(outgoing) >= 2:
            missing_conditions = [e for e in outgoing if 'condition' not in e]
            if missing_conditions:
                issues.append({
                    'type': 'decision_missing_conditions',
                    'node_id': node['id'],
                    'label': node.get('label', ''),
                    'outgoing_count': len(outgoing),
                    'missing_count': len(missing_conditions),
                    'edges': [f"{e['from']} → {e['to']}" for e in missing_conditions],
                    'suggestion': '스크린샷에서 분기 조건 텍스트 확인 필요'
                })

    # 4. 중복 edge 감지
    edge_pairs = {}
    for e in data['edges']:
        key = (e['from'], e['to'])
        edge_pairs.setdefault(key, []).append(e)
    for key, edges in edge_pairs.items():
        if len(edges) > 1:
            issues.append({
                'type': 'duplicate_edge',
                'edge': f"{key[0]} → {key[1]}",
                'count': len(edges),
                'suggestion': '중복 edge 제거 필요'
            })

    return issues


def generate_vision_prompt(yaml_path, screenshot_path, issues, data):
    """AI vision 분석을 위한 프롬프트 생성"""
    sheet_name = Path(yaml_path).stem.replace('_도형', '')

    prompt = f"""## Vision 보강 분석 요청: {sheet_name}

### 입력 데이터
- 도형 YAML: `{yaml_path}`
- 스크린샷: `{screenshot_path}`

### 현재 추출된 플로우차트 구조

**노드 ({len(data['nodes'])}개):**
"""
    for n in data['nodes']:
        prompt += f"- [{n.get('type', '?')}] {n['id']}: \"{n.get('label', '')}\"\n"

    prompt += f"\n**엣지 ({len(data['edges'])}개):**\n"
    for e in data['edges']:
        cond = f" |{e['condition']}|" if 'condition' in e else ""
        prompt += f"- {e['from']} -->{cond} {e['to']}\n"

    prompt += f"\n### 자동 감지된 이슈 ({len(issues)}개)\n\n"
    for i, issue in enumerate(issues, 1):
        prompt += f"**이슈 #{i}** [{issue['type']}]\n"
        for k, v in issue.items():
            if k != 'type':
                prompt += f"  - {k}: {v}\n"
        prompt += "\n"

    prompt += """### 요청사항

스크린샷을 보고 아래 형식의 JSON corrections를 작성해주세요:

```json
{
  "sheet": "시트명",
  "corrections": [
    {
      "action": "convert_to_edge_condition",
      "node_id": "삭제할 annotation 노드 ID",
      "target_edge": {"from": "소스노드ID", "to": "타겟노드ID"},
      "condition_text": "조건 텍스트"
    },
    {
      "action": "add_edge",
      "from": "소스노드ID",
      "to": "타겟노드ID",
      "condition": "조건 (있을 경우)"
    },
    {
      "action": "remove_edge",
      "from": "소스노드ID",
      "to": "타겟노드ID"
    },
    {
      "action": "remove_node",
      "node_id": "제거할 노드 ID",
      "reason": "사유"
    },
    {
      "action": "change_node_type",
      "node_id": "노드ID",
      "new_type": "process|decision|terminal|annotation"
    }
  ]
}
```

스크린샷의 플로우차트를 꼼꼼히 확인하여:
1. 화살표 위/옆의 텍스트 라벨 → edge condition으로 변환
2. 누락된 화살표 → add_edge
3. 잘못된 화살표 → remove_edge
4. 플로우차트와 무관한 주석 노드 → remove_node
"""
    return prompt


def apply_corrections(data, corrections):
    """corrections JSON을 도형 데이터에 적용"""
    nodes = list(data['nodes'])
    edges = list(data['edges'])
    log = []

    for corr in corrections:
        action = corr['action']

        if action == 'convert_to_edge_condition':
            node_id = corr['node_id']
            target = corr['target_edge']
            condition = corr['condition_text']

            # 노드 제거
            nodes = [n for n in nodes if n['id'] != node_id]

            # 대상 edge에 condition 추가
            for e in edges:
                if e['from'] == target['from'] and e['to'] == target['to']:
                    e['condition'] = condition
                    break
            log.append(f"[조건변환] '{node_id}' → edge {target['from']}→{target['to']} 조건: '{condition}'")

        elif action == 'add_edge':
            edge = {'from': corr['from'], 'to': corr['to']}
            if 'condition' in corr and corr['condition']:
                edge['condition'] = corr['condition']
            edges.append(edge)
            log.append(f"[엣지추가] {corr['from']} → {corr['to']}")

        elif action == 'remove_edge':
            before = len(edges)
            edges = [e for e in edges
                     if not (e['from'] == corr['from'] and e['to'] == corr['to'])]
            removed = before - len(edges)
            log.append(f"[엣지삭제] {corr['from']} → {corr['to']} ({removed}개)")

        elif action == 'remove_node':
            node_id = corr['node_id']
            nodes = [n for n in nodes if n['id'] != node_id]
            edges = [e for e in edges if e['from'] != node_id and e['to'] != node_id]
            log.append(f"[노드삭제] '{node_id}' — {corr.get('reason', '')}")

        elif action == 'change_node_type':
            for n in nodes:
                if n['id'] == corr['node_id']:
                    old = n.get('type', '?')
                    n['type'] = corr['new_type']
                    log.append(f"[타입변경] '{corr['node_id']}' {old} → {corr['new_type']}")
                    break

    return {'nodes': nodes, 'edges': edges}, log


def generate_mermaid(data, direction='LR'):
    """보강된 데이터로 Mermaid 코드 생성"""
    lines = [f"flowchart {direction}"]

    for node in data['nodes']:
        nid = node['id']
        label = node.get('label', nid).replace('"', "'")
        ntype = node.get('type', 'process')

        if ntype == 'terminal':
            lines.append(f'  {nid}(["{label}"])')
        elif ntype == 'decision':
            lines.append(f'  {nid}{{"{label}"}}')
        else:
            lines.append(f'  {nid}["{label}"]')

    lines.append("")

    for edge in data['edges']:
        f = edge['from']
        t = edge['to']
        if f == '?' or t == '?':
            continue
        cond = edge.get('condition', '')
        if cond:
            lines.append(f'  {f} -->|{cond}| {t}')
        else:
            lines.append(f'  {f} --> {t}')

    return '\n'.join(lines)


def write_reinforced_md(original_md_path, data, corrections_meta, output_path=None):
    """보강된 데이터로 _도형.md 파일 업데이트"""
    if output_path is None:
        output_path = original_md_path

    # 원본 md에서 헤더와 원본 도형 텍스트 섹션 보존
    original_lines = []
    original_text_section = []
    in_original_text = False

    with open(original_md_path, 'r', encoding='utf-8') as f:
        for line in f:
            if '### 원본 도형 텍스트' in line:
                in_original_text = True
            if in_original_text:
                original_text_section.append(line)
            elif line.startswith('#') and '도형/플로우차트' in line:
                original_lines.append(line)
            elif line.startswith('>'):
                original_lines.append(line)

    # 새 md 생성
    md = ''.join(original_lines) + '\n'

    # YAML 구조
    md += "### 도형 구조 (YAML) — Vision 보강 적용\n\n"
    md += "```yaml\n"
    md += "nodes:\n"
    for node in data['nodes']:
        md += f"  - id: {node['id']}\n"
        md += f"    type: {node.get('type', 'process')}\n"
        label = node.get('label', node['id'])
        md += f'    label: "{label}"\n'
    md += "\nedges:\n"
    for edge in data['edges']:
        md += f"  - from: {edge['from']}\n"
        md += f"    to: {edge['to']}\n"
        if 'condition' in edge:
            md += f'    condition: "{edge["condition"]}"\n'
    md += "```\n\n"

    # Mermaid
    mermaid = generate_mermaid(data)
    md += "### 플로우차트 (Mermaid) — Vision 보강 적용\n\n"
    md += f"```mermaid\n{mermaid}\n```\n\n"

    # 보강 이력
    md += "### Vision 보강 이력\n\n"
    for item in corrections_meta.get('log', []):
        md += f"- {item}\n"
    md += "\n"

    # 원본 도형 텍스트 보존
    if original_text_section:
        md += ''.join(original_text_section)

    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(md)

    return output_path


def find_image_markers(md_path):
    """Markdown 파일에서 [IMAGE: ...] 마커를 찾아 반환"""
    markers = []
    with open(md_path, 'r', encoding='utf-8') as f:
        for i, line in enumerate(f, 1):
            # Tier 1 마커: [IMAGE: 행 N-M, 열 X-Y 영역에 시각 자료 포함 — 스크린샷 참조 필요]
            m = re.search(r'\[IMAGE: 행 (\d+)-(\d+), 열 (\d+)-(\d+) 영역에 시각 자료 포함', line)
            if m:
                markers.append({
                    'line': i,
                    'from_row': int(m.group(1)),
                    'to_row': int(m.group(2)),
                    'from_col': int(m.group(3)),
                    'to_col': int(m.group(4)),
                    'source': 'tier1'
                })
                continue
            # Tier 1.5 마커: [IMAGE: 스크린샷 참조 필요]
            m2 = re.search(r'행 (\d+)-(\d+), 열 (\d+)-(\d+) \[IMAGE: 스크린샷 참조 필요\]', line)
            if m2:
                markers.append({
                    'line': i,
                    'from_row': int(m2.group(1)),
                    'to_row': int(m2.group(2)),
                    'from_col': int(m2.group(3)),
                    'to_col': int(m2.group(4)),
                    'source': 'tier15'
                })
    return markers


def _get_context_lines(md_path, line_num, context=5):
    """마커 주변 텍스트를 반환 (이미지의 문맥 파악용)"""
    lines = []
    with open(md_path, 'r', encoding='utf-8') as f:
        all_lines = f.readlines()
    start = max(0, line_num - context - 1)
    end = min(len(all_lines), line_num + context)
    for i in range(start, end):
        prefix = '>>>' if i == line_num - 1 else '   '
        lines.append(f"{prefix} {i+1}: {all_lines[i].rstrip()}")
    return '\n'.join(lines)


def generate_image_analysis_prompt(md_path, screenshot_path):
    """이미지 마커 기반으로 시각 자료 분석용 AI 프롬프트 생성"""
    markers = find_image_markers(md_path)
    if not markers:
        return None, []

    sheet_name = Path(md_path).stem

    prompt = f"""## 이미지 분석 요청: {sheet_name}

### 스크린샷
- 파일: `{screenshot_path}`

### 분석 대상 이미지 ({len(markers)}개)

아래의 각 이미지 영역에 대해 스크린샷을 참고하여 구조화된 설명을 작성해주세요.

"""
    for i, marker in enumerate(markers, 1):
        context = _get_context_lines(md_path, marker['line'])
        prompt += f"""#### 이미지 #{i}: 행 {marker['from_row']}-{marker['to_row']}, 열 {marker['from_col']}-{marker['to_col']}

**주변 문맥:**
```
{context}
```

"""

    prompt += """### 출력 형식

각 이미지에 대해 다음 JSON 형식으로 작성해주세요:

```json
{
  "sheet": "시트명",
  "image_descriptions": [
    {
      "location": {"from_row": N, "to_row": M, "from_col": X, "to_col": Y},
      "type": "diagram|chart|table|wireframe|icon|other",
      "title": "이미지 제목/설명 (주변 문맥에서 추론)",
      "description": "이미지에 표시된 내용의 구조화된 설명",
      "structured_data": {
        "설명키": "설명값"
      }
    }
  ]
}
```

### 설명 작성 가이드

1. **diagram (도식/다이어그램)**: 도형의 종류, 파라미터, 좌표계 등을 구조화
   - 예: Circle → `{"shape": "Circle", "params": {"Pivot": "중심점", "Radius": "반지름"}}`
   - 예: Rectangle → `{"shape": "Rectangle", "params": {"Pivot": "기준점", "Width": "너비", "Height": "높이"}}`
   - 예: Arc → `{"shape": "Arc", "params": {"Pivot": "중심점", "Radius": "반지름", "Angle": "각도"}}`

2. **wireframe (UI 와이어프레임)**: 화면 구성 요소, 레이아웃, 버튼/텍스트 위치
3. **chart (차트)**: 축, 범례, 데이터 포인트
4. **table (표)**: 행/열 구조로 재현
5. **icon**: 아이콘의 의미와 용도
"""
    return prompt, markers


def _write_desc_yaml(lines, data, indent=0):
    """구조화 데이터를 읽기 좋은 YAML 형태로 blockquote 안에 작성"""
    prefix = '  ' * indent
    if isinstance(data, dict):
        for k, v in data.items():
            if isinstance(v, dict):
                lines.append(f"> {prefix}{k}:\n")
                _write_desc_yaml(lines, v, indent + 1)
            elif isinstance(v, list):
                lines.append(f"> {prefix}{k}:\n")
                for item in v:
                    lines.append(f"> {prefix}  - {item}\n")
            else:
                lines.append(f"> {prefix}{k}: {v}\n")
    elif isinstance(data, list):
        for item in data:
            lines.append(f"> {prefix}- {item}\n")


def apply_image_descriptions(md_path, descriptions, output_path=None):
    """이미지 설명을 MD 파일의 [IMAGE] 마커 위치에 삽입"""
    if output_path is None:
        output_path = md_path

    with open(md_path, 'r', encoding='utf-8') as f:
        lines = f.readlines()

    # location → description 매핑
    desc_map = {}
    for desc in descriptions:
        loc = desc['location']
        key = (loc['from_row'], loc['to_row'], loc['from_col'], loc['to_col'])
        desc_map[key] = desc

    # 기존 [시각 자료 설명] 블록 제거 (중복 방지 — idempotent)
    # 라인 단위 상태 머신: 설명 블록 시작 → blockquote/빈줄 동안 스킵
    cleaned_lines = []
    in_desc_block = False
    for line in lines:
        if '**[시각 자료 설명]**' in line:
            in_desc_block = True
            continue
        if in_desc_block:
            stripped = line.strip()
            # 설명 블록 내부: > 로 시작하거나 빈 줄이면 계속 스킵
            # 단, > [IMAGE: 는 새로운 마커이므로 블록 종료
            if '[IMAGE:' in line:
                in_desc_block = False
                cleaned_lines.append(line)
            elif stripped == '' or stripped.startswith('>'):
                continue  # 설명 블록 내부 — 스킵
            else:
                in_desc_block = False
                cleaned_lines.append(line)
        else:
            cleaned_lines.append(line)
    lines = cleaned_lines

    new_lines = []
    for i, line in enumerate(lines):
        new_lines.append(line)

        # [IMAGE] 마커 찾기
        m = re.search(r'\[IMAGE: 행 (\d+)-(\d+), 열 (\d+)-(\d+) 영역에 시각 자료 포함', line)
        if m:
            key = (int(m.group(1)), int(m.group(2)), int(m.group(3)), int(m.group(4)))
            if key in desc_map:
                desc = desc_map[key]
                new_lines.append(f"\n> **[시각 자료 설명]** ({desc.get('type', 'other')}): {desc.get('title', '')}\n")
                new_lines.append(f"> {desc.get('description', '')}\n")
                if desc.get('structured_data'):
                    new_lines.append(f">\n> ```yaml\n")
                    _write_desc_yaml(new_lines, desc['structured_data'], indent=0)
                    new_lines.append(f"> ```\n")
                new_lines.append("\n")

    with open(output_path, 'w', encoding='utf-8') as f:
        f.writelines(new_lines)

    return output_path


def _load_env():
    """ConvertProgram/.env에서 환경 변수 로드"""
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '.env')
    env_path = os.path.normpath(env_path)
    env = {}
    if os.path.exists(env_path):
        with open(env_path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    k, v = line.split('=', 1)
                    env[k.strip()] = v.strip()
    return env


def call_bedrock_vision(image_path, prompt_text, model_id='us.anthropic.claude-3-5-sonnet-20241022-v2:0', max_tokens=4096):
    """AWS Bedrock Vision API 호출 (Bearer Token 인증)

    Args:
        image_path: 이미지 파일 경로 (PNG/JPG)
        prompt_text: 분석 요청 텍스트
        model_id: Bedrock 모델 ID
        max_tokens: 최대 응답 토큰

    Returns:
        str: AI 응답 텍스트
    """
    import urllib.request
    import base64

    env = _load_env()
    token = env.get('AWS_BEARER_TOKEN_BEDROCK')
    region = env.get('AWS_REGION', 'us-east-1')

    if not token:
        raise RuntimeError("AWS_BEARER_TOKEN_BEDROCK not found in .env")

    # 이미지를 base64로 인코딩
    with open(image_path, 'rb') as f:
        image_data = base64.standard_b64encode(f.read()).decode('ascii')

    ext = os.path.splitext(image_path)[1].lower()
    media_type = {'png': 'image/png', '.png': 'image/png',
                  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg'}.get(ext, 'image/png')

    url = f'https://bedrock-runtime.{region}.amazonaws.com/model/{model_id}/invoke'

    body = json.dumps({
        'anthropic_version': 'bedrock-2023-05-31',
        'max_tokens': max_tokens,
        'messages': [{
            'role': 'user',
            'content': [
                {
                    'type': 'image',
                    'source': {
                        'type': 'base64',
                        'media_type': media_type,
                        'data': image_data
                    }
                },
                {
                    'type': 'text',
                    'text': prompt_text
                }
            ]
        }]
    }).encode('utf-8')

    req = urllib.request.Request(url, data=body, method='POST')
    req.add_header('Content-Type', 'application/json')
    req.add_header('Authorization', f'Bearer {token}')

    with urllib.request.urlopen(req, timeout=120) as resp:
        result = json.loads(resp.read().decode('utf-8'))
        return result['content'][0]['text']


def auto_analyze_images(md_path, screenshot_path, output_json=None):
    """IMAGE 마커를 Bedrock Vision API로 자동 분석하여 descriptions JSON 생성

    Args:
        md_path: Markdown 파일 경로
        screenshot_path: 스크린샷 이미지 경로
        output_json: 출력 JSON 경로 (기본: {시트명}_image_descriptions.json)

    Returns:
        str: 출력 JSON 경로
    """
    prompt, markers = generate_image_analysis_prompt(md_path, screenshot_path)
    if not prompt:
        return None

    sheet_name = Path(md_path).stem

    # Vision API 호출
    response = call_bedrock_vision(screenshot_path, prompt)

    # JSON 추출 (응답에서 ```json ... ``` 블록 파싱)
    json_match = re.search(r'```json\s*\n(.*?)\n```', response, re.DOTALL)
    if json_match:
        desc_data = json.loads(json_match.group(1))
    else:
        # JSON 블록 없으면 전체를 JSON으로 파싱 시도
        desc_data = json.loads(response)

    if output_json is None:
        output_json = os.path.join(os.path.dirname(md_path), f'{sheet_name}_image_descriptions.json')

    with open(output_json, 'w', encoding='utf-8') as f:
        json.dump(desc_data, f, ensure_ascii=False, indent=2)

    return output_json


def main():
    parser = argparse.ArgumentParser(description='Tier 2 Vision 보강 도구')
    sub = parser.add_subparsers(dest='command')

    # analyze: 이슈 감지 + 프롬프트 생성
    p_analyze = sub.add_parser('analyze', help='도형 데이터 분석 + AI 프롬프트 생성')
    p_analyze.add_argument('yaml_path', help='_도형.yaml 파일 경로')
    p_analyze.add_argument('screenshot_path', help='스크린샷 경로')
    p_analyze.add_argument('--output', '-o', help='프롬프트 출력 파일')

    # apply: corrections JSON 적용
    p_apply = sub.add_parser('apply', help='corrections JSON을 도형 데이터에 적용')
    p_apply.add_argument('corrections_json', help='corrections JSON 파일 경로')
    p_apply.add_argument('yaml_path', help='_도형.yaml 파일 경로')
    p_apply.add_argument('md_path', help='_도형.md 파일 경로')
    p_apply.add_argument('--output', '-o', help='출력 _도형.md 경로 (기본: 원본 덮어쓰기)')

    # image-analyze: 이미지 마커 분석 프롬프트 생성
    p_img = sub.add_parser('image-analyze', help='이미지 마커 기반 분석 프롬프트 생성')
    p_img.add_argument('md_path', help='Markdown 파일 경로 (Tier 1 또는 Tier 1.5)')
    p_img.add_argument('screenshot_path', help='스크린샷 경로')
    p_img.add_argument('--output', '-o', help='프롬프트 출력 파일')

    # image-apply: 이미지 설명 JSON 적용
    p_img_apply = sub.add_parser('image-apply', help='이미지 설명을 MD에 삽입')
    p_img_apply.add_argument('descriptions_json', help='이미지 설명 JSON 파일 경로')
    p_img_apply.add_argument('md_path', help='대상 Markdown 파일 경로')
    p_img_apply.add_argument('--output', '-o', help='출력 MD 경로 (기본: 원본 덮어쓰기)')

    # image-auto: Vision API로 자동 분석 + 적용
    p_auto = sub.add_parser('image-auto', help='Bedrock Vision API로 이미지 자동 분석 + MD 적용')
    p_auto.add_argument('md_path', help='Markdown 파일 경로')
    p_auto.add_argument('screenshot_path', help='스크린샷 이미지 경로')
    p_auto.add_argument('--json-only', action='store_true', help='JSON만 생성, MD 적용 안 함')
    p_auto.add_argument('--output', '-o', help='출력 JSON 경로')

    args = parser.parse_args()

    if args.command == 'analyze':
        data = load_yaml_data(args.yaml_path)
        issues = analyze_issues(data)
        prompt = generate_vision_prompt(args.yaml_path, args.screenshot_path, issues, data)

        if args.output:
            with open(args.output, 'w', encoding='utf-8') as f:
                f.write(prompt)
            print(f"프롬프트 저장: {args.output}")
        else:
            print(prompt)

        print(f"\n감지된 이슈: {len(issues)}개")
        for i in issues:
            print(f"  [{i['type']}] {i.get('node_id', '')} {i.get('label', '')}")

    elif args.command == 'apply':
        with open(args.corrections_json, 'r', encoding='utf-8') as f:
            corrections_data = json.load(f)

        data = load_yaml_data(args.yaml_path)
        corrected_data, log = apply_corrections(data, corrections_data['corrections'])

        output_path = args.output or args.md_path
        write_reinforced_md(args.md_path, corrected_data,
                           {'log': log}, output_path)

        print(f"보강 적용 완료: {output_path}")
        for item in log:
            print(f"  {item}")

    elif args.command == 'image-analyze':
        prompt, markers = generate_image_analysis_prompt(args.md_path, args.screenshot_path)
        if not prompt:
            print("이미지 마커가 없습니다.")
            return

        if args.output:
            with open(args.output, 'w', encoding='utf-8') as f:
                f.write(prompt)
            print(f"이미지 분석 프롬프트 저장: {args.output}")
        else:
            print(prompt)

        print(f"\n감지된 이미지 마커: {len(markers)}개")
        for m in markers:
            print(f"  행 {m['from_row']}-{m['to_row']}, 열 {m['from_col']}-{m['to_col']} ({m['source']})")

    elif args.command == 'image-apply':
        with open(args.descriptions_json, 'r', encoding='utf-8') as f:
            desc_data = json.load(f)

        descriptions = desc_data.get('image_descriptions', [])
        output_path = apply_image_descriptions(args.md_path, descriptions, args.output)
        print(f"이미지 설명 삽입 완료: {output_path}")
        print(f"  삽입된 설명: {len(descriptions)}개")

    elif args.command == 'image-auto':
        print(f"Vision API 자동 분석 시작: {args.md_path}")
        print(f"스크린샷: {args.screenshot_path}")

        json_path = auto_analyze_images(args.md_path, args.screenshot_path, args.output)
        if not json_path:
            print("이미지 마커가 없습니다.")
            return

        print(f"분석 결과 저장: {json_path}")

        with open(json_path, 'r', encoding='utf-8') as f:
            desc_data = json.load(f)
        descriptions = desc_data.get('image_descriptions', [])
        print(f"분석된 이미지: {len(descriptions)}개")

        if not args.json_only:
            apply_image_descriptions(args.md_path, descriptions)
            print(f"MD 적용 완료: {args.md_path}")

    else:
        parser.print_help()


if __name__ == '__main__':
    main()
