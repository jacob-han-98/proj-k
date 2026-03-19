export const API_BASE_URL = 'http://127.0.0.1:8088';

export interface Source {
  workbook: string;
  sheet: string;
  section_path: string;
  score: number;
}

export interface AskResponse {
  answer: string;
  confidence: string;
  sources: Source[];
  conversation_id: string;
  total_tokens: number;
  api_seconds: number;
}

export const askQuestion = async (
  question: string,
  model: string = 'claude-opus-4-5',
  prompt_style: string = '검증세트 최적화',
  conversation_id?: string
): Promise<AskResponse> => {
  const response = await fetch(`${API_BASE_URL}/ask`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      question,
      conversation_id,
      model,
      prompt_style,
    }),
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  return response.json();
};

/** NDJSON 스트리밍 이벤트 타입 */
export type StreamEvent =
  | { type: 'status'; message: string }
  | { type: 'result'; data: AskResponse }
  | { type: 'error'; message: string };

/**
 * SSE 스트리밍으로 QnA 질문. NDJSON 라인을 파싱하여 콜백 호출.
 */
export const askQuestionStream = async (
  question: string,
  onEvent: (event: StreamEvent) => void,
  model: string = 'claude-opus-4-5',
  prompt_style: string = '검증세트 최적화',
  conversation_id?: string,
): Promise<void> => {
  const response = await fetch(`${API_BASE_URL}/ask_stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, conversation_id, model, prompt_style }),
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // 마지막 불완전 라인은 버퍼에 유지

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event: StreamEvent = JSON.parse(trimmed);
        onEvent(event);
      } catch {
        // 파싱 실패한 라인은 무시
      }
    }
  }

  // 버퍼에 남은 마지막 라인 처리
  if (buffer.trim()) {
    try {
      onEvent(JSON.parse(buffer.trim()));
    } catch {
      // ignore
    }
  }
};
