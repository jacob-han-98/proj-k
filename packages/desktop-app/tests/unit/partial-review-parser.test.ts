// A5: 스트리밍 partial JSON 파서 — chrome-extension 의 _parsePartialReviewJSON TS 포팅.
// 핵심 사용성: token 도착 중에도 완결된 항목들이 즉시 카드로 노출.

import { describe, expect, it } from 'vitest';
import { parsePartialReviewJSON } from '../../src/renderer/panels/partial-review-parser';

describe('parsePartialReviewJSON', () => {
  it('전체 valid JSON 은 그대로 파싱', () => {
    const raw = JSON.stringify({
      score: 80,
      issues: [{ text: '플로우 누락', perspective: '프로그래머' }],
      suggestions: ['개선안 1'],
    });
    const r = parsePartialReviewJSON(raw);
    expect(r).not.toBeNull();
    expect(r!.score).toBe(80);
    expect(r!.issues!.length).toBe(1);
    expect(r!.suggestions!.length).toBe(1);
  });

  it('markdown fence 안의 JSON 도 파싱', () => {
    const raw = '```json\n{"score": 90, "issues": []}\n```';
    const r = parsePartialReviewJSON(raw);
    expect(r!.score).toBe(90);
  });

  it('partial — 문 닫히기 전 — score + 닫힌 issues 만 추출', () => {
    // issues 의 첫 객체는 닫혔고 두번째는 열려있음.
    const raw = `{
      "score": 75,
      "issues": [
        {"text": "첫 보강 사항", "perspective": "프로그래머"},
        {"text": "두번째 진행중`;
    const r = parsePartialReviewJSON(raw);
    expect(r).not.toBeNull();
    expect(r!.score).toBe(75);
    expect(r!.issues!.length).toBe(1); // 닫힌 첫 객체만
    const first = r!.issues![0];
    expect(typeof first === 'object' && first.text).toBe('첫 보강 사항');
  });

  it('partial — 여러 array 부분 도착', () => {
    const raw = `{
      "score": 60,
      "issues": [{"text":"a","perspective":"프로그래머"},{"text":"b","perspective":"리더"}],
      "verifications": [{"text":"v1"}],
      "suggestions": ["sug1", "sug2`;  // 두번째 string 안 닫힘
    const r = parsePartialReviewJSON(raw);
    expect(r!.issues!.length).toBe(2);
    expect(r!.verifications!.length).toBe(1);
    expect(r!.suggestions!.length).toBe(1); // 닫힌 string 만
  });

  it('partial — flow 만 도착', () => {
    const raw = `{"score": 50, "flow": "1. 시작 2. 종료"`;
    const r = parsePartialReviewJSON(raw);
    expect(r!.flow).toBe('1. 시작 2. 종료');
  });

  it('partial — readability score 만', () => {
    const raw = `{"score": 70, "readability": {"score": 65`;
    const r = parsePartialReviewJSON(raw);
    expect(r!.readability!.score).toBe(65);
  });

  it('빈 raw → null', () => {
    expect(parsePartialReviewJSON('')).toBeNull();
  });

  it('아무 필드 없으면 null', () => {
    expect(parsePartialReviewJSON('garbage text without keys')).toBeNull();
  });

  it('qa_checklist 문자열 배열도 추출 — 닫힌 string 만', () => {
    // C 의 string 이 닫히지 않은 상태 (token 이 아직 도착 중인 케이스).
    const raw = `{"qa_checklist": ["A 확인", "B 확인", "C 확인`;
    const r = parsePartialReviewJSON(raw);
    expect(r!.qa_checklist!.length).toBe(2);
    expect(r!.qa_checklist).toEqual(['A 확인', 'B 확인']);
  });

  it('qa_checklist — 모두 닫혔지만 array 미닫힘', () => {
    const raw = `{"qa_checklist": ["A", "B", "C"`;
    const r = parsePartialReviewJSON(raw);
    expect(r!.qa_checklist!.length).toBe(3);
  });
});
