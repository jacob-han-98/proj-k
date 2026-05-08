// 액티비티 바 5번 ("내 작업 중 문서") — `p4 -ztag opened` stdout parser 검증.
// 사용자가 P4 에서 체크아웃한 .xlsx 파일만 골라 ActiveP4File[] 로 반환되는지.

import { describe, expect, it } from 'vitest';
import { parseP4OpenedZTag } from '../../src/main/p4-discovery';

const TWO_RECORDS = [
  '... depotFile //main/ProjectK/Design/HUD.xlsx',
  '... clientFile //jacob-D/Design/HUD.xlsx',
  '... rev 3',
  '... haveRev 3',
  '... action edit',
  '... change default',
  '... type binary+l',
  '... user jacob',
  '... client jacob-D',
  '',
  '... depotFile //main/ProjectK/Combat.xlsx',
  '... clientFile //jacob-D/Combat.xlsx',
  '... rev 7',
  '... action add',
  '... type binary',
  '... user jacob',
  '... client jacob-D',
  '',
].join('\n');

describe('parseP4OpenedZTag', () => {
  it('두 레코드 정상 parse — depotFile / action / rev / clientFile / type 추출', () => {
    const out = parseP4OpenedZTag(TWO_RECORDS);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      depotPath: '//main/ProjectK/Design/HUD.xlsx',
      clientPath: '//jacob-D/Design/HUD.xlsx',
      action: 'edit',
      revision: 3,
      type: 'binary+l',
    });
    expect(out[1]).toEqual({
      depotPath: '//main/ProjectK/Combat.xlsx',
      clientPath: '//jacob-D/Combat.xlsx',
      action: 'add',
      revision: 7,
      type: 'binary',
    });
  });

  it('빈 stdout → 빈 배열', () => {
    expect(parseP4OpenedZTag('')).toEqual([]);
    expect(parseP4OpenedZTag('\n\n')).toEqual([]);
  });

  it('.xlsx 가 아닌 파일은 필터링 (Klaud 가 못 여는 type)', () => {
    const stdout = [
      '... depotFile //main/ProjectK/script.cs',
      '... rev 1',
      '... action edit',
      '',
      '... depotFile //main/ProjectK/HUD.xlsx',
      '... rev 1',
      '... action edit',
      '',
    ].join('\n');
    const out = parseP4OpenedZTag(stdout);
    expect(out).toHaveLength(1);
    expect(out[0]?.depotPath).toBe('//main/ProjectK/HUD.xlsx');
  });

  it('대소문자 무관 .XLSX 도 매칭 — 사용자 파일명 일관성 X 케이스 대비', () => {
    const stdout = [
      '... depotFile //main/A.XLSX',
      '... rev 1',
      '... action edit',
      '',
    ].join('\n');
    const out = parseP4OpenedZTag(stdout);
    expect(out).toHaveLength(1);
    expect(out[0]?.depotPath).toBe('//main/A.XLSX');
  });

  it('필드 누락 관대 — depotFile 만 있으면 OK, action 미지정은 edit fallback', () => {
    const stdout = [
      '... depotFile //main/A.xlsx',
      '',
    ].join('\n');
    const out = parseP4OpenedZTag(stdout);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      depotPath: '//main/A.xlsx',
      action: 'edit', // fallback default
      revision: 0,    // rev 미지정 → 0
    });
  });

  it('CRLF (Windows p4.exe) 도 정상 split', () => {
    const stdout =
      '... depotFile //main/A.xlsx\r\n' +
      '... rev 5\r\n' +
      '... action edit\r\n' +
      '\r\n' +
      '... depotFile //main/B.xlsx\r\n' +
      '... rev 1\r\n' +
      '... action add\r\n' +
      '\r\n';
    const out = parseP4OpenedZTag(stdout);
    expect(out).toHaveLength(2);
    expect(out[0]?.revision).toBe(5);
    expect(out[1]?.action).toBe('add');
  });

  it('잘못된 줄 (... 이 아닌 라인) 은 silently 무시', () => {
    const stdout = [
      'p4 server message we should ignore',
      '... depotFile //main/A.xlsx',
      'another junk line',
      '... rev 1',
      '... action edit',
      '',
    ].join('\n');
    const out = parseP4OpenedZTag(stdout);
    expect(out).toHaveLength(1);
    expect(out[0]?.depotPath).toBe('//main/A.xlsx');
  });

  it('한글 path 도 보존', () => {
    const stdout = [
      '... depotFile //main/ProjectK/기획서/HUD 시스템.xlsx',
      '... clientFile //jacob-D/기획서/HUD 시스템.xlsx',
      '... rev 12',
      '... action edit',
      '',
    ].join('\n');
    const out = parseP4OpenedZTag(stdout);
    expect(out[0]?.depotPath).toBe('//main/ProjectK/기획서/HUD 시스템.xlsx');
    expect(out[0]?.clientPath).toBe('//jacob-D/기획서/HUD 시스템.xlsx');
    expect(out[0]?.revision).toBe(12);
  });
});
