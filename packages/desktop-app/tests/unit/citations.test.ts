import { describe, expect, it } from 'vitest';
import { extractCitationStrings, annotateCitedHits } from '../../src/renderer/citations';
import type { SearchHit } from '../../src/shared/types';

const hit = (over: Partial<SearchHit>): SearchHit => ({
  type: 'xlsx',
  doc_id: 'X',
  title: 'X',
  path: 'X',
  snippet: '',
  score: 0,
  source: 'vector',
  ...over,
});

describe('extractCitationStrings', () => {
  it('추출: 단일', () => {
    expect(extractCitationStrings('내용 (출처: PK_HUD 시스템.xlsx / HUD_기본 § 레이아웃) 끝'))
      .toEqual(['PK_HUD 시스템.xlsx / HUD_기본 § 레이아웃']);
  });

  it('추출: 복수', () => {
    const ans = '문장1 (출처: A.xlsx / 시트1) 그리고 (출처: Confluence / 공간 / 페이지) 끝';
    expect(extractCitationStrings(ans)).toEqual([
      'A.xlsx / 시트1',
      'Confluence / 공간 / 페이지',
    ]);
  });

  it('추출: 인용 없음', () => {
    expect(extractCitationStrings('출처가 없는 평문')).toEqual([]);
  });

  it('전역 lastIndex 가 호출 사이에 누적되지 않는다', () => {
    const a = '... (출처: A.xlsx / 1)';
    expect(extractCitationStrings(a)).toEqual(['A.xlsx / 1']);
    expect(extractCitationStrings(a)).toEqual(['A.xlsx / 1']);
  });
});

describe('annotateCitedHits', () => {
  it('워크북명 매칭으로 cited 표시', () => {
    const answer = 'HUD 레이아웃은 ... (출처: PK_HUD 시스템.xlsx / HUD_기본 § 레이아웃)';
    const hits = [
      hit({ doc_id: 'PK_HUD 시스템', title: 'PK_HUD 시스템' }),
      hit({ doc_id: '다른 워크북', title: '다른 워크북' }),
    ];
    const out = annotateCitedHits(answer, hits);
    expect(out[0].cited).toBe(true);
    expect(out[1].cited).toBe(false);
  });

  it('matched_sheets 의 시트명으로도 매칭', () => {
    const answer = '...(출처: 어떤워크북.xlsx / HUD_기본 § a)';
    const hits = [hit({ title: '어떤워크북', matched_sheets: ['HUD_기본'] })];
    expect(annotateCitedHits(answer, hits)[0].cited).toBe(true);
  });

  it('인용이 0 개면 모두 false', () => {
    const out = annotateCitedHits('출처 없는 답변', [hit({ title: 'X' })]);
    expect(out[0].cited).toBe(false);
  });

  it('Confluence 페이지명 substring 매칭', () => {
    const answer = '...(출처: Confluence / 시스템 디자인 / HUD 개편안 § Foo)';
    const hits = [hit({ type: 'confluence', title: 'HUD 개편안' })];
    expect(annotateCitedHits(answer, hits)[0].cited).toBe(true);
  });

  it('너무 짧은 (1글자) title 은 매칭 노이즈를 피해 false', () => {
    const answer = '...(출처: A.xlsx / 시트)';
    const hits = [hit({ title: 'A' })];
    expect(annotateCitedHits(answer, hits)[0].cited).toBe(false);
  });
});
