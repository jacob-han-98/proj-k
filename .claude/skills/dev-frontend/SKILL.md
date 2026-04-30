---
name: dev-frontend
description: "React 프론트엔드 개발/빌드/배포 워크플로우. '프론트 실행', 'dev server', 'npm run', '프론트 빌드', 'vite', 'React 개발', 'UI 수정' 등을 요청하면 트리거."
argument-hint: "[dev | build | deploy]"
---

# 프론트엔드 개발 워크플로우

packages/frontend (React + Vite + TypeScript) 개발 환경.

## 명령어

### 로컬 개발
```bash
cd "c:/Users/jacob.JACOB-D/Documents/proj-k 기획/packages/frontend"
npm run dev
# → http://localhost:5173 (Vite dev server, HMR)
# → API: http://127.0.0.1:8088 (로컬 FastAPI 서버 별도 실행 필요)
```

### 프로덕션 빌드
```bash
cd "c:/Users/jacob.JACOB-D/Documents/proj-k 기획/packages/frontend"
npm run build
# → dist/ 폴더에 정적 파일 생성
```

### 서버 배포
`/deploy` 스킬 참조. 빌드 후 `scp`로 서버에 업로드.

## 프로젝트 구조

```
packages/frontend/
├── src/
│   ├── App.tsx              # 메인 (채팅, 테마, Mermaid)
│   ├── AdminPage.tsx        # 관리자 페이지
│   ├── ConflictsPage.tsx    # 충돌 스캔 결과
│   ├── ProposalView.tsx     # 기획서 수정 제안 뷰
│   ├── QualityCriteriaPanel.tsx  # 품질 기준 패널
│   ├── SharedPage.tsx       # 대화 공유 페이지
│   ├── api.ts               # API 클라이언트 (SSE 스트리밍)
│   ├── App.css              # 스타일
│   └── main.tsx             # 엔트리포인트
├── vite.config.ts           # Vite 설정 (base: /proj-k/)
└── package.json
```

## Gotchas

- **API base URL 분기**: `api.ts`에서 `MODE === 'production'`이면 `/proj-k/api`, 아니면 `127.0.0.1:8088` 직접 접속. 로컬 개발 시 FastAPI 서버가 8088에서 돌고 있어야 함
- **vite.config.ts base path**: 프로덕션은 `/proj-k/`, 개발은 `/`. 서버 배포 시 base가 `/`면 모든 라우팅 깨짐
- **Mermaid 렌더링 실패**: 복잡하거나 문법 오류인 다이어그램은 콘솔 에러만 남기고 조용히 실패. F12로 확인
- **sessionStorage 휘발**: 대화 히스토리가 `sessionStorage`에 저장됨. 탭 닫으면 전부 사라짐 (의도된 동작)
- **TypeScript 빌드 순서**: `npm run build`는 `tsc -b && vite build`. TS 에러 있으면 빌드 자체가 실패
- **npm install 먼저**: `package-lock.json` 변경 후 `npm install` 안 하면 모듈 누락 에러
- **CORS**: 로컬 개발 시 FastAPI에 CORS 미들웨어 필요. 현재 `api.py`에 `*` 허용 설정됨
