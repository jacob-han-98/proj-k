// onlyoffice-host.ts 의 단위 테스트 — 경로 변환과 serve.py 위치 결정.
//
// PoC 0.1.53+: main 이 WSL serve.py spawn 으로 OnlyOffice 임베드 viewer URL 발급.
// 이 테스트는 OS-call 없이 path translation 만 격리 검증한다 (실제 spawn / WSL IP / fetch
// 는 e2e 또는 manual smoke 으로).
import { describe, expect, it, vi, beforeEach } from 'vitest';

// paths.getDesktopAppDir 가 OS 의존 — mock 으로 격리. settings 도 같이 mock (paths 가 import).
vi.mock('../../src/main/paths', () => ({
  getDesktopAppDir: vi.fn(),
}));
vi.mock('../../src/main/settings', () => ({
  effectiveRepoRoot: vi.fn(),
}));

// electron app.on() 등록을 회피 — 모듈 import 만으로 listener 가 register 되지 않게.
vi.mock('electron', () => ({
  app: { on: vi.fn() },
}));

import { __test } from '../../src/main/onlyoffice-host';
import { getDesktopAppDir } from '../../src/main/paths';

const { windowsPathToWsl, getServePyWslPath } = __test;

describe('windowsPathToWsl', () => {
  it('Windows drive letter → /mnt/<drive>/...', () => {
    expect(windowsPathToWsl('D:\\ProjectK\\Design\\7_System\\PK_HUD 시스템.xlsx')).toBe(
      '/mnt/d/ProjectK/Design/7_System/PK_HUD 시스템.xlsx',
    );
    expect(windowsPathToWsl('C:\\Users\\jacob\\foo.xlsx')).toBe('/mnt/c/Users/jacob/foo.xlsx');
  });

  it('UNC \\\\wsl.localhost\\<distro>\\... → /...', () => {
    expect(
      windowsPathToWsl('\\\\wsl.localhost\\Ubuntu-24.04\\home\\jacob\\repos\\proj-k\\file.xlsx'),
    ).toBe('/home/jacob/repos/proj-k/file.xlsx');
    expect(windowsPathToWsl('\\\\wsl$\\Ubuntu\\home\\jacob\\foo')).toBe('/home/jacob/foo');
  });

  it('forward-slash UNC variant', () => {
    expect(windowsPathToWsl('//wsl.localhost/Ubuntu-24.04/home/jacob/x.xlsx')).toBe(
      '/home/jacob/x.xlsx',
    );
  });

  it('already WSL native path → unchanged (with backslash normalize)', () => {
    expect(windowsPathToWsl('/home/jacob/foo.xlsx')).toBe('/home/jacob/foo.xlsx');
    expect(windowsPathToWsl('/mnt/d/x')).toBe('/mnt/d/x');
  });

  it('empty / null-ish → empty', () => {
    expect(windowsPathToWsl('')).toBe('');
  });
});

describe('getServePyWslPath', () => {
  beforeEach(() => {
    vi.mocked(getDesktopAppDir).mockReset();
  });

  it('desktopAppDir 미설정 → hardcoded Windows fallback (translated)', () => {
    vi.mocked(getDesktopAppDir).mockReturnValue('');
    expect(getServePyWslPath()).toBe('/mnt/e/repos/proj-k/packages/excel-viewer-poc/serve.py');
  });

  it('desktopAppDir Windows path → sibling excel-viewer-poc 로 /mnt/<drive>/...', () => {
    vi.mocked(getDesktopAppDir).mockReturnValue('E:\\repos\\proj-k\\packages\\desktop-app');
    expect(getServePyWslPath()).toBe('/mnt/e/repos/proj-k/packages/excel-viewer-poc/serve.py');
  });

  it('desktopAppDir trailing slash → no double slash', () => {
    vi.mocked(getDesktopAppDir).mockReturnValue('E:\\repos\\proj-k\\packages\\desktop-app\\');
    expect(getServePyWslPath()).toBe('/mnt/e/repos/proj-k/packages/excel-viewer-poc/serve.py');
  });
});
