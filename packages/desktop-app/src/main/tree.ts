import { getXlsxOutputDir, getConfluenceOutputDir } from './paths';
import { buildP4Tree, buildConfluenceTreeFromManifest } from './tree-core';
import { getSidecarStatus } from './sidecar';
import type { P4TreeResult, ConfluenceTreeResult } from '../shared/types';

// Tree 빌드는 sidecar(WSL Linux Python) 가 native FS 로 처리하는 게 가장 안정적이고 빠르다.
// Klaud main(Windows) 가 직접 \\wsl.localhost\... UNC 경로로 fs.readdir 하면 9P 프로토콜
// 이슈로 빈 결과를 받는 케이스가 발생. 따라서 main 은 sidecar HTTP 호출만 하고,
// sidecar 가 안에서 PROJK_REPO_ROOT(UNC) 를 native Linux 경로로 정규화한 뒤 트리를 빌드한다.
//
// fallback: sidecar 가 ready 가 아닐 때 (또는 호출 실패 시) 기존 tree-core 로 시도.

export { buildP4Tree, buildConfluenceTreeFromManifest } from './tree-core';

async function fetchSidecarTree(path: '/tree/p4' | '/tree/confluence'): Promise<unknown | null> {
  const sc = getSidecarStatus();
  if (sc.state !== 'ready' || sc.port == null) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${sc.port}${path}`, { method: 'GET' });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.warn(`[tree] sidecar ${path} 호출 실패`, e);
    return null;
  }
}

export async function getP4Tree(): Promise<P4TreeResult> {
  const fromSidecar = await fetchSidecarTree('/tree/p4');
  if (fromSidecar && typeof fromSidecar === 'object') {
    return fromSidecar as P4TreeResult;
  }
  // fallback: dev 환경 (sidecar 안 떴을 때) tree-core 로 직접 빌드
  const rootDir = getXlsxOutputDir();
  const nodes = rootDir ? await buildP4Tree(rootDir) : [];
  return { nodes, rootDir, loadedAt: Date.now() };
}

export async function getConfluenceTree(): Promise<ConfluenceTreeResult> {
  const fromSidecar = await fetchSidecarTree('/tree/confluence');
  if (fromSidecar && typeof fromSidecar === 'object') {
    return fromSidecar as ConfluenceTreeResult;
  }
  const outDir = getConfluenceOutputDir();
  const manifestPath = outDir ? `${outDir}/_manifest.json` : '';
  const nodes = manifestPath ? await buildConfluenceTreeFromManifest(manifestPath) : [];
  return { nodes, rootDir: outDir, loadedAt: Date.now() };
}
