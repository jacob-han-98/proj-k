---
name: projk-ui-style
description: "Project K QnA 계열 웹 UI의 룩앤필·레이아웃·컴포넌트 가이드. 사이드바 280px + 메인 chat + 하단 입력 도킹, CSS 변수 기반 테마(System/Light/Dark), glassmorphism, Pretendard 타이포. 'UI 스타일', '테마', '레이아웃', 'CSS 토큰' 관련 요청에 트리거."
---

# Project K UI 스타일 가이드

이 스킬은 Project K 계열(qna-poc, agent-sdk-poc, 후속 기획 에이전트 UI)의 **룩앤필 사양**이다. 새 페이지/뷰 만들 때 이 가이드를 따르면 프로젝트 전반의 일관성이 유지된다.

**canonical 구현**: `packages/frontend/src/App.css` (2081 lines), `packages/frontend/src/index.css`.
에이전트-sdk 복사본: `packages/agent-sdk-poc/frontend/src/App.css`.

---

## 1) 테마 토큰 (CSS 변수)

모든 색은 CSS 변수로 선언하고, `data-theme` 속성으로 전환한다.

```css
:root {
  /* Light (default) */
  --bg-primary: #FFFFFF;
  --bg-secondary: #F8FAFC;
  --bg-sidebar: #F1F5F9;
  --text-primary: #1E293B;
  --text-secondary: #64748B;
  --border: #E2E8F0;
  --accent: #6366F1;
  --accent-hover: #4F46E5;
  --user-bubble: #E8F0FE;
  --assistant-bubble: #F8F9FA;
}

[data-theme="dark"] {
  --bg-primary: #0F172A;
  --bg-secondary: #1E293B;
  --bg-sidebar: #1A202C;
  --text-primary: #F8FAFC;
  --text-secondary: #94A3B8;
  --border: #334155;
  --accent: #818CF8;
  --accent-hover: #A5B4FC;
  --user-bubble: #1E3A8A;
  --assistant-bubble: #1E293B;
}

[data-theme="system"] {
  /* 기본은 Light 토큰 적용, media query 로 dark 덮어씀 */
}
@media (prefers-color-scheme: dark) {
  [data-theme="system"] {
    --bg-primary: #0F172A;
    /* ... 위 dark 블록 전체 반복 ... */
  }
}
```

- 테마 전환은 `document.documentElement.setAttribute('data-theme', mode)` + `localStorage.setItem('qna-theme', mode)`.
- 최초 로드 시 OS preference 와 `localStorage` 를 모두 체크.

## 2) 타이포그래피

- **Font stack**: Pretendard (Korean-optimized) → `-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif` fallback.
- **Crisp 렌더링**: `-webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;`
- **Scale**:
  | 용도 | 크기 | 굵기 |
  |------|-----:|------|
  | 페이지 타이틀 (main-title) | 2.25rem (36px) | 700 |
  | 서브 타이틀 | 1.1rem (17.6px) | 400 |
  | H2 | 1.5rem | 700 |
  | H3 | 1.2rem | 600 |
  | 본문 | 1rem (16px) | 400 |
  | 사이드 레이블 | 0.85rem | 500, uppercase letter-spacing 0.5px |
  | 소형 메타 | 0.75rem | 400 |
- 한국어 행간: `line-height: 1.7` (본문), `1.4` (타이틀).

## 3) 레이아웃 (`.layout`)

```
┌─────────────────────────────────────────────────────┐
│  aside.sidebar (280px, flex-column)                 │
│  ┌───────────────┐  main.main-content (flex: 1)    │
│  │ sidebar-header│  ┌──────────────────────────┐   │
│  │ new-chat-btn  │  │  chat-scroll-area        │   │
│  │ sidebar-     │  │  (flex: 1, overflow-y)   │   │
│  │   section    │  │                          │   │
│  │  history-list│  │                          │   │
│  │               │  │                          │   │
│  │ sidebar-     │  └──────────────────────────┘   │
│  │   footer     │  ┌──────────────────────────┐   │
│  │ (theme, admin)│  │ input-container (glass)  │   │
│  └───────────────┘  └──────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

- 사이드바: `width: 280px; padding: 24px; gap: 20px; display: flex; flex-direction: column;`
- 메인: `display: flex; flex-direction: column; height: 100vh;`
- 모바일 (width ≤ 768): 사이드바 숨김 + `mobile-topbar` 출현, drawer 방식으로 열고 닫음.

## 4) Glassmorphism

**반투명 + blur** 효과는 표면에만 사용 (사이드바, 입력 dock, 프리셋 카드, 메시지 버블).

```css
.glass {
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  background: color-mix(in srgb, var(--bg-primary) 70%, transparent);
  border: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
}
```

- 컨텐츠 블록(본문, 테이블)에는 적용하지 않는다 (가독성 저하).
- PDF export 시에는 `backdrop-filter: none` 으로 재작성해야 html2pdf에서 렌더 가능.

## 5) 컴포넌트 프리미티브

### 버튼
```css
.new-chat-btn {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 16px; border-radius: 8px;
  background: var(--text-primary); color: var(--bg-primary);
  font-weight: 600; cursor: pointer;
  transition: opacity 0.15s;
}
.new-chat-btn:hover { opacity: 0.9; }

.kb-btn {
  padding: 8px 12px; border-radius: 6px;
  background: transparent; border: 1px solid var(--border);
  font-size: 0.85rem; cursor: pointer;
}
.send-btn {
  width: 32px; height: 32px; border-radius: 50%;
  background: var(--accent); color: white;
  display: grid; place-items: center;
}
.send-btn:disabled { opacity: 0.4; cursor: not-allowed; }
```

### 카드
```css
.prompt-card {
  padding: 12px 16px; border-radius: 10px;
  text-align: left; cursor: pointer;
  transition: transform 0.15s, border-color 0.15s;
}
.prompt-card:hover { transform: translateY(-1px); border-color: var(--accent); }
/* 2열 그리드 */
.suggested-prompts {
  display: grid; grid-template-columns: repeat(2, 1fr);
  gap: 10px; max-width: 720px; margin: 0 auto;
}
```

### 메시지 버블
```css
.message {
  padding: 12px 16px; border-radius: 12px;
  max-width: 80%; line-height: 1.7;
}
.message.user       { background: var(--user-bubble); margin-left: auto; }
.message.assistant  { background: var(--assistant-bubble); margin-right: auto; }
.message-wrapper    { display: flex; margin-bottom: 16px; }
.message-wrapper.user      { justify-content: flex-end; }
.message-wrapper.assistant { justify-content: flex-start; }
```

### 출처 카드 (`.source-link-card`)
```css
.source-link-card {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 8px; border-radius: 6px;
  font-size: 0.8rem; text-decoration: none;
  color: var(--text-secondary);
}
```

### 로딩
```css
.loading-spinner {
  width: 14px; height: 14px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
```

## 6) 상호작용 규칙

- **메시지 호버** → 복사/PDF 버튼 opacity 0 → 1 (0.15s).
- **사이드바 히스토리** → 항목 클릭 시 `.active` 클래스 → 좌측 accent bar.
- **프리셋 클릭** → 입력창 value 설정 + `focus()`.
- **Ctrl+Enter** 전송, **Enter** 줄바꿈 (모바일은 shift+enter 불필요).
- **프레리듀스드 모션**: `@media (prefers-reduced-motion: reduce) { * { animation-duration: 0.01ms !important; } }`

## 7) 접근성

- 포커스 링 유지 (`:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }`).
- 아이콘 버튼은 항상 `title` 또는 `aria-label`.
- 색 대비 WCAG AA: 본문 `--text-primary` vs `--bg-primary` 4.5:1 이상.
- Ctrl+Enter 단축키는 placeholder 에 명시.

## 8) 사용 금지 스타일

- **네온 그라데이션**, **무지개 보더** 등 장식 효과.
- **fixed-position 팝업** 은 모달(overlay + centered card) 이외 피한다.
- **과도한 애니메이션** (fade-in > 0.3s, scale transform 등).
- **자체 폰트**(Google Fonts 로드 등) — Pretendard 또는 시스템 fallback만.

## 9) 에이전트 적용

새 페이지/컴포넌트 작성 시:
1. 먼저 `App.css` 의 canonical 클래스(`.layout`, `.sidebar`, `.main-content`, `.message`, `.prompt-card` 등)를 재사용한다.
2. 새 primitve가 필요하면 이 스킬을 먼저 업데이트한 뒤 CSS에 반영한다. 임의 커스텀 클래스 남발 금지.
3. 테마 토큰 외의 하드코드 색 사용 금지 (예: `color: #333` X → `var(--text-primary)` O).

## 변경 이력

- 2026-04-19 초판. agent-sdk-poc 포팅과 함께 정리 (`packages/agent-sdk-poc/frontend/src/App.css`).
