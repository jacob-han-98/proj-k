import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildP4Tree, buildConfluenceTreeFromManifest } from '../../src/main/tree-core';

// ---------- P4 (xlsx-extractor) 트리 ----------

describe('buildP4Tree', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'projk-p4-'));

    // category/workbook/sheet/_final/content.md  (정상 케이스)
    await mkdir(join(root, '7_System', 'PK_HUD 시스템', 'HUD_기본', '_final'), { recursive: true });
    await writeFile(join(root, '7_System', 'PK_HUD 시스템', 'HUD_기본', '_final', 'content.md'), '# 더미');
    await mkdir(join(root, '7_System', 'PK_HUD 시스템', 'HUD_전투', '_final'), { recursive: true });
    await writeFile(join(root, '7_System', 'PK_HUD 시스템', 'HUD_전투', '_final', 'content.md'), '# 더미');

    await mkdir(join(root, '7_System', 'PK_변신 시스템', 'Tier1', '_final'), { recursive: true });
    await writeFile(join(root, '7_System', 'PK_변신 시스템', 'Tier1', '_final', 'content.md'), '# 더미');

    // 8_Contents/<workbook>/<sheet>/_final/content.md
    await mkdir(join(root, '8_Contents', 'PK_던전', 'D1', '_final'), { recursive: true });
    await writeFile(join(root, '8_Contents', 'PK_던전', 'D1', '_final', 'content.md'), '# 더미');

    // 루트에 떨어진 단독 워크북 (category 안 거치고 직접 sheet)
    await mkdir(join(root, 'PK_단독워크북', '시트1', '_final'), { recursive: true });
    await writeFile(join(root, 'PK_단독워크북', '시트1', '_final', 'content.md'), '# 더미');

    // _ 로 시작하는 디렉터리 (skip 대상)
    await mkdir(join(root, '_internal'), { recursive: true });

    // _final 없는 빈 워크북 (드롭되어야 함)
    await mkdir(join(root, '7_System', 'PK_빈워크북', '시트1'), { recursive: true });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('카테고리 → 워크북 → 시트 3-깊이 트리를 만든다', async () => {
    const tree = await buildP4Tree(root);

    // 7_System, 8_Contents, (기타) — 3개의 category 노드
    const titles = tree.map((n) => n.title);
    expect(titles).toContain('7_System');
    expect(titles).toContain('8_Contents');
    expect(titles).toContain('(기타)');

    const sysNode = tree.find((n) => n.title === '7_System')!;
    expect(sysNode.type).toBe('category');
    const sysWorkbooks = sysNode.children!.map((n) => n.title);
    expect(sysWorkbooks).toContain('PK_HUD 시스템');
    expect(sysWorkbooks).toContain('PK_변신 시스템');
    expect(sysWorkbooks).not.toContain('PK_빈워크북'); // _final 없으면 제외
  });

  it('한글 정렬은 ko 로케일을 따른다', async () => {
    const tree = await buildP4Tree(root);
    const sys = tree.find((n) => n.title === '7_System')!;
    const titles = sys.children!.map((n) => n.title);
    expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b, 'ko')));
  });

  it('루트 단독 워크북은 (기타) 카테고리로 묶는다', async () => {
    const tree = await buildP4Tree(root);
    const misc = tree.find((n) => n.title === '(기타)')!;
    expect(misc.children!.map((n) => n.title)).toContain('PK_단독워크북');
  });

  it('시트 노드는 relPath 와 sheet:<rel> id 를 갖는다', async () => {
    const tree = await buildP4Tree(root);
    const sys = tree.find((n) => n.title === '7_System')!;
    const hud = sys.children!.find((n) => n.title === 'PK_HUD 시스템')!;
    const sheet = hud.children!.find((n) => n.title === 'HUD_기본')!;
    expect(sheet.type).toBe('sheet');
    expect(sheet.relPath).toBe(join('7_System', 'PK_HUD 시스템', 'HUD_기본'));
    expect(sheet.id.startsWith('sheet:')).toBe(true);
  });

  it('빈 디렉터리에서는 빈 배열을 반환한다 (예외 없이)', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'projk-empty-'));
    try {
      const tree = await buildP4Tree(empty);
      expect(tree).toEqual([]);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

// ---------- Confluence (manifest) 트리 ----------

describe('buildConfluenceTreeFromManifest', () => {
  it('중첩 children 을 TreeNode 트리로 변환한다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'projk-conf-'));
    const manifestPath = join(dir, '_manifest.json');
    const manifest = {
      id: '1',
      title: 'Design',
      type: 'page',
      depth: 0,
      version: 1,
      children: [
        {
          id: '2',
          title: '시스템 디자인',
          type: 'folder',
          depth: 1,
          children: [
            { id: '3', title: '전투', type: 'page', depth: 2, children: [] },
            { id: '4', title: 'HUD', type: 'page', depth: 2, children: [] },
          ],
        },
        { id: '5', title: '운영', type: 'folder', depth: 1, children: [] },
      ],
    };
    await writeFile(manifestPath, JSON.stringify(manifest));

    try {
      const nodes = await buildConfluenceTreeFromManifest(manifestPath);
      expect(nodes).toHaveLength(1);
      const root = nodes[0];
      expect(root.title).toBe('Design');
      expect(root.confluencePageId).toBe('1');
      expect(root.children).toHaveLength(2);

      const design = root.children!.find((n) => n.title === '시스템 디자인')!;
      expect(design.type).toBe('folder');
      expect(design.children).toHaveLength(2);
      expect(design.children!.map((c) => c.title).sort()).toEqual(['HUD', '전투']);

      // relPath 가 부모 title 체인을 누적하는지
      const hud = design.children!.find((n) => n.title === 'HUD')!;
      expect(hud.relPath).toBe('Design/시스템 디자인/HUD');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('manifest 없으면 빈 배열', async () => {
    const nodes = await buildConfluenceTreeFromManifest('/nonexistent/path/_manifest.json');
    expect(nodes).toEqual([]);
  });
});
