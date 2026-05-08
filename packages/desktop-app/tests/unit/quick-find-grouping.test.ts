import { describe, expect, it } from 'vitest';
import {
  buildConfluencePathMap,
  groupHits,
  lookupConfluencePageId,
  normalizeXlsxPath,
} from '../../src/renderer/workbench/Sidebar/quick-find-grouping';
import type { QuickFindHit, TreeNode } from '../../src/shared/types';

const hit = (over: Partial<QuickFindHit>): QuickFindHit => ({
  doc_id: 'xlsx::W::S',
  type: 'xlsx',
  title: 'S',
  path: '7_System / W / S',
  workbook: 'W',
  space: null,
  summary: '',
  score: 0,
  matched_via: 'l1',
  rank: 0,
  content_md_path: '',
  source: 'l1',
  ...over,
});

describe('groupHits', () => {
  it('같은 워크북의 시트 hit 들은 하나의 workbook 그룹으로 묶인다', () => {
    const groups = groupHits([
      hit({ doc_id: 'xlsx::PK_HUD::HUD_기본', title: 'HUD_기본', workbook: 'PK_HUD', path: '7_System / PK_HUD / HUD_기본' }),
      hit({ doc_id: 'xlsx::PK_HUD::HUD_채팅', title: 'HUD_채팅', workbook: 'PK_HUD', path: '7_System / PK_HUD / HUD_채팅' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe('workbook');
    if (groups[0].kind === 'workbook') {
      expect(groups[0].workbook).toBe('PK_HUD');
      expect(groups[0].path).toBe('7_System / PK_HUD');
      expect(groups[0].sheets).toHaveLength(2);
    }
  });

  it('confluence hit 은 workbook 그룹으로 묶이지 않고 single 로 유지', () => {
    const groups = groupHits([
      hit({ doc_id: 'conf::Design/HUD-개편', type: 'confluence', title: 'HUD 개편', path: 'Design / HUD-개편', workbook: null }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe('single');
  });

  it('서로 다른 워크북은 각자의 그룹으로 분리', () => {
    const groups = groupHits([
      hit({ doc_id: 'xlsx::A::s1', workbook: 'A', path: '/ A / s1' }),
      hit({ doc_id: 'xlsx::B::s1', workbook: 'B', path: '/ B / s1' }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => (g.kind === 'workbook' ? g.workbook : ''))).toEqual(['A', 'B']);
  });

  it('xlsx + confluence 혼합 시 백엔드 ranking 순서 보존 (그룹 위치 = 첫 시트 위치)', () => {
    const groups = groupHits([
      hit({ doc_id: 'xlsx::PK_HUD::s1', workbook: 'PK_HUD', path: '/ PK_HUD / s1' }),
      hit({ doc_id: 'conf::A', type: 'confluence', workbook: null, path: 'A' }),
      hit({ doc_id: 'xlsx::PK_HUD::s2', workbook: 'PK_HUD', path: '/ PK_HUD / s2' }),
      hit({ doc_id: 'conf::B', type: 'confluence', workbook: null, path: 'B' }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(['xlsx::PK_HUD', 'conf::A', 'conf::B']);
    if (groups[0].kind === 'workbook') {
      expect(groups[0].sheets.map((h) => h.doc_id)).toEqual([
        'xlsx::PK_HUD::s1',
        'xlsx::PK_HUD::s2',
      ]);
    }
  });

  it('xlsx 인데 workbook 필드가 비면 single 로 fallback (현 데이터 흠 방지)', () => {
    const groups = groupHits([
      hit({ doc_id: 'xlsx::orphan', workbook: null, path: 'orphan' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe('single');
  });

  it('빈 입력은 빈 배열', () => {
    expect(groupHits([])).toEqual([]);
  });

  it('백엔드가 fold 한 hit (matched_sheets 동봉) 은 그 자식들로 workbook 그룹 생성', () => {
    const groups = groupHits([
      hit({
        doc_id: 'xlsx::PK_HUD',
        title: 'PK_HUD',
        path: '7_System / PK_HUD',
        workbook: 'PK_HUD',
        score: 2.78,
        matched_sheets: [
          { sheet: 'HUD_전투', doc_id: 'xlsx::PK_HUD::HUD_전투', score: 0.95, matched_via: 'title_prefix', source: 'l1' },
          { sheet: 'HUD_기본', doc_id: 'xlsx::PK_HUD::HUD_기본', score: 0.95, matched_via: 'title_prefix', source: 'l1' },
          { sheet: '히스토리', doc_id: 'xlsx::PK_HUD::히스토리', score: 0.88, matched_via: 'workbook_substring', source: 'l1' },
        ],
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe('workbook');
    if (groups[0].kind === 'workbook') {
      expect(groups[0].workbook).toBe('PK_HUD');
      expect(groups[0].path).toBe('7_System / PK_HUD');
      expect(groups[0].sheets).toHaveLength(3);
      expect(groups[0].sheets.map((s) => s.doc_id)).toEqual([
        'xlsx::PK_HUD::HUD_전투',
        'xlsx::PK_HUD::HUD_기본',
        'xlsx::PK_HUD::히스토리',
      ]);
      // 자식 시트의 path 는 부모 path + 시트명 으로 합성
      expect(groups[0].sheets[0].path).toBe('7_System / PK_HUD / HUD_전투');
      // 시트 누락 필드는 부모에서 채워짐 (workbook)
      expect(groups[0].sheets[0].workbook).toBe('PK_HUD');
    }
  });

  it('matched_sheets 분기는 자식이 1개여도 동작 (legacy fold 와 분리)', () => {
    const groups = groupHits([
      hit({
        doc_id: 'xlsx::Solo',
        workbook: 'Solo',
        path: 'Solo',
        matched_sheets: [
          { sheet: 'Sheet1', doc_id: 'xlsx::Solo::Sheet1', score: 0.5 },
        ],
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe('workbook');
  });
});

describe('groupHits — confluence parent-folder fold', () => {
  it('같은 parent 폴더에 ≥2 hit 면 묶임 (depth 자유)', () => {
    const groups = groupHits([
      hit({ doc_id: 'conf::a', type: 'confluence', title: '매지션', path: '시스템 디자인 / 클래스 / 매지션', workbook: null }),
      hit({ doc_id: 'conf::b', type: 'confluence', title: '아처', path: '시스템 디자인 / 클래스 / 아처', workbook: null }),
      hit({ doc_id: 'conf::c', type: 'confluence', title: '샤먼', path: '시스템 디자인 / 클래스 / 샤먼', workbook: null }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe('confluence-folder');
    if (groups[0].kind === 'confluence-folder') {
      expect(groups[0].folderPath).toBe('시스템 디자인 / 클래스');
      expect(groups[0].pages).toHaveLength(3);
    }
  });

  it('depth 4 path — 같은 parent (3 segments) 가 ≥2 면 그 깊이로 묶임', () => {
    const groups = groupHits([
      hit({ doc_id: 'conf::1', type: 'confluence', path: '시스템 / 길드 / 길드전 / 결투', workbook: null }),
      hit({ doc_id: 'conf::2', type: 'confluence', path: '시스템 / 길드 / 길드전 / 매칭', workbook: null }),
    ]);
    expect(groups).toHaveLength(1);
    if (groups[0].kind === 'confluence-folder') {
      expect(groups[0].folderPath).toBe('시스템 / 길드 / 길드전');
    }
  });

  it('parent 가 1 hit 만 가지면 그룹화 X — single 로 (합칠 게 없음)', () => {
    const groups = groupHits([
      hit({ doc_id: 'conf::lonely', type: 'confluence', path: '시스템 / 길드 / 외톨이', workbook: null }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe('single');
  });

  it('서로 다른 parent — 각각 ≥2 면 둘 다 그룹화', () => {
    const groups = groupHits([
      hit({ doc_id: 'conf::1', type: 'confluence', path: 'A / B / X', workbook: null }),
      hit({ doc_id: 'conf::2', type: 'confluence', path: 'A / B / Y', workbook: null }),
      hit({ doc_id: 'conf::3', type: 'confluence', path: 'A / C / Z', workbook: null }),
      hit({ doc_id: 'conf::4', type: 'confluence', path: 'A / C / W', workbook: null }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].kind).toBe('confluence-folder');
    expect(groups[1].kind).toBe('confluence-folder');
  });

  it('단일 hit 은 group 으로 자동 합치지 않음 — 그룹의 그룹 X', () => {
    // path: A/B/X, A/B/Y, A/C/Z — A/B 부모 2개, A/C 부모 1개. A/C 는 single, A 로 또 합치지 않음.
    const groups = groupHits([
      hit({ doc_id: 'conf::1', type: 'confluence', path: 'A / B / X', workbook: null }),
      hit({ doc_id: 'conf::2', type: 'confluence', path: 'A / B / Y', workbook: null }),
      hit({ doc_id: 'conf::3', type: 'confluence', path: 'A / C / Z', workbook: null }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].kind).toBe('confluence-folder'); // A/B 그룹
    expect(groups[1].kind).toBe('single'); // A/C/Z 단독
  });

  it('confluence path ≤1 segment 는 single (parent 없음)', () => {
    const groups = groupHits([
      hit({ doc_id: 'conf::top', type: 'confluence', path: '루트', workbook: null }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe('single');
  });

  it('xlsx workbook 그룹과 confluence 그룹 공존 — backend ranking 보존', () => {
    const groups = groupHits([
      hit({
        doc_id: 'xlsx::PK_HUD',
        workbook: 'PK_HUD',
        path: '7_System / PK_HUD',
        matched_sheets: [{ sheet: 'HUD_전투', doc_id: 'xlsx::PK_HUD::HUD_전투', score: 1 }],
      }),
      hit({ doc_id: 'conf::a', type: 'confluence', path: '시스템 / A / page1', workbook: null }),
      hit({ doc_id: 'conf::b', type: 'confluence', path: '시스템 / A / page2', workbook: null }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].kind).toBe('workbook');
    expect(groups[1].kind).toBe('confluence-folder');
    if (groups[1].kind === 'confluence-folder') {
      expect(groups[1].pages).toHaveLength(2);
    }
  });
});

describe('confluence path → pageId lookup', () => {
  const tree: TreeNode[] = [
    {
      id: 'confluence:root',
      type: 'folder',
      title: 'Design',
      children: [
        {
          id: 'confluence:1',
          type: 'folder',
          title: '컨텐츠 디자인',
          children: [
            {
              id: 'confluence:2',
              type: 'folder',
              title: '레벨',
              children: [
                {
                  id: 'confluence:3',
                  type: 'folder',
                  title: '서대륙_레벨',
                  children: [
                    { id: 'confluence:4', type: 'page', title: '필드_가시나무 숲', confluencePageId: '12345' },
                    { id: 'confluence:5', type: 'page', title: '필드_물이 할퀸 땅', confluencePageId: '67890' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ];

  it('full path 매칭 — root prefix 포함', () => {
    const map = buildConfluencePathMap(tree);
    expect(lookupConfluencePageId(map, 'Design/컨텐츠 디자인/레벨/서대륙_레벨/필드_가시나무 숲')).toBe('12345');
  });

  it('hit.path 가 root prefix 빠진 형태도 suffix match 로 잡음', () => {
    const map = buildConfluencePathMap(tree);
    // backend hit.path 형태 — " / " separator + Design root 빠짐
    expect(lookupConfluencePageId(map, '컨텐츠 디자인 / 레벨 / 서대륙_레벨 / 필드_가시나무 숲')).toBe('12345');
  });

  it('leaf title 만으로도 매칭 (suffix loop fallback)', () => {
    const map = buildConfluencePathMap(tree);
    expect(lookupConfluencePageId(map, '필드_가시나무 숲')).toBe('12345');
  });

  it('알 수 없는 path 는 undefined', () => {
    const map = buildConfluencePathMap(tree);
    expect(lookupConfluencePageId(map, '알 수 없는 / 페이지')).toBeUndefined();
  });

  it('빈 path → undefined', () => {
    const map = buildConfluencePathMap(tree);
    expect(lookupConfluencePageId(map, '')).toBeUndefined();
  });

  it('folder 노드는 매핑되지 X (page 만)', () => {
    const map = buildConfluencePathMap(tree);
    expect(lookupConfluencePageId(map, 'Design/컨텐츠 디자인/레벨')).toBeUndefined();
  });

  it('콜론 → 언더스코어 정규화 — manifest 는 콜론, backend hit 은 언더스코어', () => {
    // manifest tree 의 title 이 콜론 형태 — sidecar 가 그대로 줌
    const treeWithColon: TreeNode[] = [
      {
        id: 'r',
        type: 'page',
        title: 'Design',
        children: [
          {
            id: 'c1',
            type: 'folder',
            title: '컨텐츠 디자인',
            children: [
              {
                id: 'c2',
                type: 'folder',
                title: '레벨',
                children: [
                  {
                    id: 'c3',
                    type: 'folder',
                    title: '서대륙:레벨',
                    children: [
                      {
                        id: 'p1',
                        type: 'page',
                        title: '필드: 가시나무 숲',
                        confluencePageId: '5656412176',
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];
    const map = buildConfluencePathMap(treeWithColon);
    // backend hit.path 는 file-safe form: 콜론이 언더스코어로 바뀐 형태
    expect(lookupConfluencePageId(map, '컨텐츠 디자인 / 레벨 / 서대륙_레벨 / 필드_ 가시나무 숲'))
      .toBe('5656412176');
  });
});

describe('normalizeXlsxPath', () => {
  // .xlsx 는 부착하지 않음 — 호출자 (buildEmbedUrl 등) 가 부착하므로 .xlsx.xlsx 회피.
  it('이미 .xlsx 면 떼어내고 반환 (호출자가 다시 부착하므로 중복 방지)', () => {
    expect(normalizeXlsxPath('a/b/c.xlsx')).toBe('a/b');
  });

  it('표준 슬래시 separator + 시트 segment 제거', () => {
    expect(normalizeXlsxPath('8_Contents/PK_몬스터/시트A')).toBe('8_Contents/PK_몬스터');
  });

  it('backend display path " / " separator 의 trailing/leading 공백 제거', () => {
    expect(normalizeXlsxPath('8_Contents / PK_몬스터_셀레탄_배반자들의소굴 / 라자루 진리회 사제_전투'))
      .toBe('8_Contents/PK_몬스터_셀레탄_배반자들의소굴');
  });

  it('워크북 path (시트 segment 없음) — slash ≤ 2', () => {
    expect(normalizeXlsxPath('7_System / PK_HUD')).toBe('7_System/PK_HUD');
  });

  it('단일 segment 그대로', () => {
    expect(normalizeXlsxPath('PK_HUD')).toBe('PK_HUD');
  });

  it('내부 공백이 있는 segment 는 보존 (공백 제거 X, trim 만)', () => {
    expect(normalizeXlsxPath('8_Contents / PK_캐릭터 성장 밸런스')).toBe('8_Contents/PK_캐릭터 성장 밸런스');
  });

  it('빈 segment 는 제거', () => {
    expect(normalizeXlsxPath('//foo//bar//baz//')).toBe('foo/bar');
  });
});
