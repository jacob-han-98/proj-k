// PR3: Quick Find 사이드바 — placeholder 만. 백엔드 연결 + 결과 렌더는 다음 마일스톤.
// 의도: VS Code 검색 패널 모방 (input + 결과 리스트). 지금은 input disabled + 안내문.

export function QuickFindPanel() {
  return (
    <div className="quick-find-panel" data-testid="quick-find-panel">
      <div className="qf-input-row">
        <i className="codicon codicon-search qf-input-icon" aria-hidden="true" />
        <input
          type="text"
          className="qf-input"
          placeholder="엑셀 / 컨플루언스 빠르게 찾기 (다음 마일스톤)"
          disabled
          data-testid="qf-input"
        />
      </div>
      <div className="qf-empty" data-testid="qf-empty">
        agentic search + Haiku 기반 빠른 메타 검색이 다음 마일스톤에서 들어옵니다.
        문서 제목 / 시트 / 워크북 메타로 검색해 결과를 클릭하면 editor 탭으로 열립니다.
      </div>
    </div>
  );
}
