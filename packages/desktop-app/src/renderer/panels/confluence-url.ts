// 2026-05-13: Confluence Cloud URL 분류 — view ↔ edit ↔ draft ↔ create.
// CenterPane 의 ConfluencePane 이 webview did-navigate 시 호출.
//
// 별도 모듈로 분리한 이유: 단위 테스트에서 CenterPane 을 import 하면 ../api.ts 가
// 같이 로드되며 top-level 의 `window.projk?...` 가 node 환경에서 ReferenceError 를 던짐.
// 순수 함수만 떨어뜨려서 jsdom/window 없이도 직접 테스트 가능하게 함.
//
// 패턴 (Atlassian Cloud 기준):
//   /wiki/spaces/<KEY>/pages/edit-v2/<id>     현행 v2 에디터
//   /wiki/spaces/<KEY>/pages/edit/<id>        구 v1 에디터 (일부 페이지)
//   /wiki/pages/resumedraft.action            이어쓰기
//   /wiki/pages/createpage.action             신규 페이지 작성 (편집 흐름 동일)
// view URL 은 viewpage.action 이거나 /pages/<id>/<slug> 같은 정규 형태.
export function isConfluenceEditUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const p = u.pathname.toLowerCase();
    if (p.includes('/pages/edit-v2/')) return true;
    if (p.includes('/pages/edit/')) return true;
    if (p.endsWith('/resumedraft.action')) return true;
    if (p.endsWith('/createpage.action')) return true;
    return false;
  } catch {
    return false;
  }
}
