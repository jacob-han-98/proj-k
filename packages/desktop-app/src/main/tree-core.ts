// Pure tree-building logic with no electron / paths dependency, so it can be
// imported by Vitest tests directly. Wrappers in tree.ts inject the real paths.

import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';
import type { TreeNode } from '../shared/types';

async function readDir(path: string): Promise<string[]> {
  try {
    return await fs.readdir(path);
  } catch (e) {
    // 진단: UNC 경로(\\wsl.localhost\...) 에서 fs.readdir 실패 원인 노출.
    // 권한, 연결 안 됨, 9P 타임아웃 등 어느 케이스인지 main 콘솔에 남기면
    // 사용자가 DevTools 보거나 self-test 가 다음 단계에서 잡을 수 있다.
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[tree] readdir 실패: ${path} → ${msg}`);
    return [];
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function pathHasFinalContentDirect(dir: string, entries: string[]): Promise<boolean> {
  for (const entry of entries) {
    if (entry.startsWith('_') || entry.startsWith('.')) continue;
    const probe = join(dir, entry, '_final', 'content.md');
    if (await isFile(probe)) return true;
  }
  return false;
}

async function buildWorkbookNode(
  workbookName: string,
  workbookPath: string,
  rootDir: string,
): Promise<TreeNode | null> {
  const sheetEntries = await readDir(workbookPath);
  const sheets: TreeNode[] = [];

  for (const entry of sheetEntries) {
    if (entry.startsWith('_') || entry.startsWith('.')) continue;
    const sheetPath = join(workbookPath, entry);
    if (!(await isDir(sheetPath))) continue;

    const contentPath = join(sheetPath, '_final', 'content.md');
    if (await isFile(contentPath)) {
      sheets.push({
        id: `sheet:${relative(rootDir, sheetPath)}`,
        type: 'sheet',
        title: entry,
        relPath: relative(rootDir, sheetPath),
      });
    }
  }

  if (sheets.length === 0) return null;
  sheets.sort((a, b) => a.title.localeCompare(b.title, 'ko'));

  return {
    id: `workbook:${relative(rootDir, workbookPath)}`,
    type: 'workbook',
    title: workbookName,
    relPath: relative(rootDir, workbookPath),
    children: sheets,
  };
}

// xlsx-extractor output layout:
//   <category>/<workbook>/<sheet>/_final/content.md
// Top-level entries that aren't categories (single workbooks dropped at root)
// are surfaced under a "(기타)" group.
export async function buildP4Tree(rootDir: string): Promise<TreeNode[]> {
  const rootEntries = await readDir(rootDir);
  const categories: TreeNode[] = [];
  const looseWorkbooks: TreeNode[] = [];

  for (const entry of rootEntries) {
    if (entry.startsWith('_') || entry.startsWith('.')) continue;
    const fullPath = join(rootDir, entry);
    if (!(await isDir(fullPath))) continue;

    const subEntries = await readDir(fullPath);
    const looksLikeWorkbook = await pathHasFinalContentDirect(fullPath, subEntries);

    if (looksLikeWorkbook) {
      const node = await buildWorkbookNode(entry, fullPath, rootDir);
      if (node) looseWorkbooks.push(node);
    } else {
      const workbooks: TreeNode[] = [];
      for (const sub of subEntries) {
        if (sub.startsWith('_') || sub.startsWith('.')) continue;
        const subPath = join(fullPath, sub);
        if (!(await isDir(subPath))) continue;
        const node = await buildWorkbookNode(sub, subPath, rootDir);
        if (node) workbooks.push(node);
      }
      if (workbooks.length > 0) {
        categories.push({
          id: `cat:${entry}`,
          type: 'category',
          title: entry,
          children: workbooks.sort((a, b) => a.title.localeCompare(b.title, 'ko')),
        });
      }
    }
  }

  categories.sort((a, b) => a.title.localeCompare(b.title, 'ko'));
  if (looseWorkbooks.length > 0) {
    categories.push({
      id: 'cat:_misc',
      type: 'category',
      title: '(기타)',
      children: looseWorkbooks.sort((a, b) => a.title.localeCompare(b.title, 'ko')),
    });
  }
  return categories;
}

// ---------- Confluence (manifest-based) ----------

interface ManifestNode {
  id: string;
  title: string;
  type: 'page' | 'folder';
  depth: number;
  version?: number;
  children?: ManifestNode[];
  output_path?: string;
}

function manifestToTreeNode(m: ManifestNode, parentPath: string[]): TreeNode {
  const path = [...parentPath, m.title];
  const children = (m.children ?? []).map((c) => manifestToTreeNode(c, path));
  return {
    id: `confluence:${m.id}`,
    type: m.type === 'folder' ? 'folder' : 'page',
    title: m.title,
    confluencePageId: m.id,
    relPath: path.join('/'),
    children: children.length > 0 ? children : undefined,
  };
}

export async function buildConfluenceTreeFromManifest(manifestPath: string): Promise<TreeNode[]> {
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, 'utf-8');
  } catch {
    return [];
  }
  const manifest: ManifestNode = JSON.parse(raw);
  return [manifestToTreeNode(manifest, [])];
}
