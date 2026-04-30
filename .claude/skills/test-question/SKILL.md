---
name: test-question
description: "단일 질문으로 QnA Agent 테스트. '이거 물어봐', '질문 테스트', '한 개만 돌려봐', 'Agent한테 물어봐', '검색 결과 확인' 등을 요청하면 트리거."
argument-hint: "질문 텍스트"
---

# QnA Agent 단일 질문 테스트

특정 질문을 Agent에 보내고 전체 파이프라인 결과를 확인합니다.

## 실행

```bash
cd "c:/Users/jacob.JACOB-D/Documents/proj-k 기획/packages/qna-poc"
PYTHONUTF8=1 python -u -c "
import json, sys
from src.agent import agent_answer
result = agent_answer('$ARGUMENTS')
print('=== 답변 ===')
print(result['answer'])
print()
print('=== 메타데이터 ===')
print(f'Confidence: {result.get(\"confidence\", \"?\")}')
print(f'Total tokens: {result[\"total_tokens\"]}')
print(f'Chunks: {len(result[\"chunks\"])}')
print()
print('=== 트레이스 ===')
for step in result.get('trace', []):
    print(f'  {step.get(\"step\", \"?\")}: {step.get(\"seconds\", 0):.1f}s')
print()
print('=== 검색된 청크 (상위 5개) ===')
for i, c in enumerate(result['chunks'][:5]):
    print(f'  [{i+1}] {c.get(\"workbook\",\"?\")}/{c.get(\"sheet\",\"?\")} (score={c.get(\"combined_score\",0):.2f})')
    print(f'      {c.get(\"text\",\"\")[:100]}...')
"
```

## Gotchas

- **작은따옴표 이스케이프**: 질문에 `'`가 포함되면 bash 문자열이 깨짐. 질문 내 작은따옴표는 `'\''`로 이스케이프하거나, 임시 Python 파일로 실행
- **ChromaDB 컬렉션 필수**: `project_k` 컬렉션이 없으면 즉시 crash. `/index-qna --reset` 먼저 실행
- **서버와 동시 실행 주의**: API 서버가 ChromaDB를 점유 중이면 lock 충돌 가능. 로컬 테스트 시 서버 중단 권장
- **PYTHONUTF8=1 필수**: Windows 한글 인코딩 문제 방지
- **긴 답변 잘림**: 터미널 버퍼 제한으로 overview 타입 답변이 잘릴 수 있음. 필요시 파일로 리다이렉트
- **"기획해줘" vs "기획서 수정해줘"**: Planning 단계에서 query_type이 달라짐. "기획해줘"=QnA overview, "기획서 수정해줘"=proposal. 의도와 다른 결과가 나오면 질문 표현 확인

## 분석 포인트

1. **답변 품질**: 질문에 정확히 답했는가?
2. **Confidence**: high/medium/low — low면 검색 결과 부족
3. **검색된 청크**: 올바른 워크북/시트에서 가져왔는가?
4. **트레이스**: Planning/Search/Answer/Reflection 각 단계 시간
5. **토큰 사용량**: 비정상적으로 높으면 프롬프트 or 컨텍스트 문제
