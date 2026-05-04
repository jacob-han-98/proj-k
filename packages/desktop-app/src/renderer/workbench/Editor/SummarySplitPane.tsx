import { useEffect, useMemo, useState } from 'react';
import { summaryStream } from '../../api';
import { SummaryCard } from '../../panels/SummaryCard';
import {
  hashContent,
  invalidateSummaryFixture,
  loadSummaryFixture,
  saveSummaryFixture,
} from '../../panels/summary-fixture-cache';
import { readErrorMessage, readToken } from '../../stream-events';

// P1: 요약 모드의 stream 호출 + 캐시 wrapper. ReviewSplitPane 의 review-fixture-cache
// 패턴 그대로지만 키 prefix / 데이터 shape 가 다름.
//
// 흐름:
// 1. mount 또는 trigger 갱신 시 캐시 hit 확인 → hit 면 즉시 카드 채우고 종료.
// 2. 캐시 miss 면 /summary_stream 호출 → status / token / result 누적 → 결과 캐시 저장.
// 3. 사용자가 "🔁 새 요약" 누르면 refreshNonce 갱신 → cache invalidate + 새 stream.

interface SummaryState {
  summary: string | null;
  streaming: boolean;
  error?: string;
  streamBuffer?: string;
  status?: string;
  cachedAt?: number | null;
  cachedModel?: string | null;
}

function readStatus(e: { [k: string]: unknown }): string | null {
  const v = e.message ?? e.payload;
  return typeof v === 'string' ? v : null;
}

interface Props {
  tabId: string;
  title: string;
  text: string;
  trigger: number;
  // confluencePageId === null 인 경우 (Excel sheet 등) 캐시 안 함.
  confluencePageId: string | null;
}

export function SummarySplitPane({ tabId: _tabId, title, text, trigger, confluencePageId }: Props) {
  const [state, setState] = useState<SummaryState>({ summary: null, streaming: true });
  const [refreshNonce, setRefreshNonce] = useState(0);

  const contentHash = useMemo(() => hashContent(text), [text]);

  useEffect(() => {
    let cancelled = false;
    const forceFresh = refreshNonce > 0;
    setState({ summary: null, streaming: true });

    if (!forceFresh && confluencePageId) {
      const fixture = loadSummaryFixture(confluencePageId, contentHash);
      if (fixture) {
        setState({
          summary: fixture.summary,
          streaming: false,
          cachedAt: fixture.savedAt,
          cachedModel: fixture.model ?? null,
        });
        return;
      }
    }
    if (forceFresh && confluencePageId) {
      invalidateSummaryFixture(confluencePageId, contentHash);
    }

    void (async () => {
      try {
        await summaryStream({ title, text }, (event) => {
          if (cancelled) return;
          const e = event as unknown as { type: string; [k: string]: unknown };
          if (e.type === 'status') {
            const s = readStatus(e);
            if (s) setState((cur) => ({ ...cur, status: s }));
          } else if (e.type === 'token') {
            const tok = readToken(e);
            if (tok) {
              setState((cur) => ({ ...cur, streamBuffer: (cur.streamBuffer ?? '') + tok }));
            }
          } else if (e.type === 'result') {
            const data = e.data as { summary?: unknown; model?: unknown } | undefined;
            const summary = typeof data?.summary === 'string' ? data.summary : null;
            const model = typeof data?.model === 'string' ? data.model : undefined;
            if (summary) {
              setState((cur) => ({ ...cur, summary, streaming: false }));
              if (confluencePageId) {
                saveSummaryFixture(confluencePageId, contentHash, summary, model);
              }
            } else {
              setState((cur) => ({ ...cur, error: 'result 파싱 실패 — data.summary 없음', streaming: false }));
            }
          } else if (e.type === 'error') {
            const msg = readErrorMessage(e) ?? '알 수 없는 오류';
            setState((cur) => ({ ...cur, error: msg, streaming: false }));
          }
        });
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setState((cur) => ({ ...cur, error: msg, streaming: false }));
      }
    })();
    return () => {
      cancelled = true;
    };
    // title/text 는 trigger 와 함께 갱신되므로 trigger / refreshNonce 만 의존성으로.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger, refreshNonce]);

  return (
    <SummaryCard
      title={title}
      summary={state.summary}
      streaming={state.streaming}
      error={state.error}
      streamBuffer={state.streamBuffer}
      status={state.status}
      cachedAt={state.cachedAt ?? null}
      cachedModel={state.cachedModel ?? null}
      onReRunRequest={() => setRefreshNonce((n) => n + 1)}
    />
  );
}
