---
name: git-hygiene
description: Safe, well-timed git commits for Project K. PROACTIVELY suggest a commit when (a) the user signals satisfaction with a just-finished feature and is moving to a new topic ("좋아 다음 주제", "이제 다른 거 하자", "만족해", "잘 되네", "완료", "넘어가자"), (b) you are about to enter plan mode for a substantial change (the user asked to plan a refactor, multi-file rewrite, or migration — commit first so the plan is easy to roll back), or (c) you judge the working tree has reached a clean, coherent checkpoint after non-trivial work. Also triggers when the user asks explicitly ("커밋해", "커밋하자", "git commit", "체크포인트"). Enforces an allowlist-style staging discipline so original planning documents, knowledge base outputs, credentials, and runtime artifacts are never committed. When ambiguous, ASK the user rather than guessing.
user-invocable: true
---

# Git Hygiene (Project K)

Project K 프로젝트의 커밋 정책과 안전장치. 사용자 작업 흐름의 자연스러운 지점에 체크포인트를 만들되, 원본 기획서·변환 산출물·대용량 데이터·크레덴셜을 절대 커밋하지 않는다.

## When to commit (자동 제안 트리거)

다음 상황에서 **사용자에게 확인받고 커밋을 제안**하라:

### 1) 피처 완료 + 다음 주제 신호
사용자 발화 패턴:
- "좋아 다음", "다음 주제로", "이제 다른 거", "넘어가자"
- "잘 됐어", "완성됐네", "만족해", "좋아", "완료"
- "이제 X 하자", "X를 해볼까" (앞 작업이 정리된 후)

이때 commit 하는 이유: 직전 피처가 테스트 되어 working state에 도달 → 되돌리기 쉬운 anchor 제공.

### 2) 플래닝 모드 진입 직전
사용자가 큰 변경을 계획하려 할 때:
- "계획 세워줘", "/plan", "큰 변경 하자", "리팩터링 계획"
- "다 다시 만들자", "재구성", "마이그레이션"

이때 commit 하는 이유: 플랜 실행 중 중단/롤백이 필요할 때 안전한 baseline.

### 3) Claude 자체 판단
다음 신호가 모이면 조용히 커밋 제안:
- 한 세션에서 여러 파일에 걸친 의미있는 변경 완료
- E2E 테스트 / Playwright PASS 확인 직후
- 배포 성공 직후 (deploy 완료, health check OK)
- CLAUDE.md / MEMORY.md / 스킬 파일 업데이트 완료
- Chrome extension 수정 후 리로드·브라우저 검증 완료

### 4) 명시적 요청
"커밋해", "git commit", "체크포인트 찍어줘" → 즉시 진행 (단, safety 규칙은 항상 적용).

## Safety rules (절대 규칙)

### ❌ 커밋하면 안 되는 것들

**외부 의존성 / 설치 산출물:**
- `.venv/`, `venv/`, `env/`, `node_modules/`
- `__pycache__/`, `*.pyc`, `.pytest_cache/`, `.ruff_cache/`, `.mypy_cache/`
- `*.egg-info/`, `build/`, `dist/`, `*.whl`

**Project K 대용량 데이터 / 원본 기획서 (별도 관리):**
- `1_High_Concept/`, `2_Development/`, `3_Base/`, `7_System/`, `9_MileStone/` (원본 XLSX/PPTX)
- `Confluence PDF Sync/` (원본 PDF 296개)
- `_knowledge_base/` (변환 결과, 대용량)
- `packages/xlsx-extractor/output/` (629 content.md + 이미지)
- `packages/confluence-downloader/output/` (489 content.md, 8.2GB)
- `packages/qna-poc/eval/results/` (평가 히스토리)
- `packages/*/logs/`, `logs/` (런타임 로그)

**ChromaDB / 인덱스:**
- `~/.qna-poc-chroma/` (repo 밖이지만 언급)
- `packages/qna-poc/chroma_db/` 등 로컬 생성 DB

**크레덴셜 / 설정:**
- `.env`, `.env.*`, `*.pem`, `*.key`
- `ConvertProgram/.env`, `packages/*/.env`
- `jacob.pem`
- `packages/chrome-extension/lib/config.js` (API 키, Confluence 토큰 포함)

**런타임 산출물 / 테스트 임시물:**
- `debug/`, `변환테스트/`, `_test_log.txt`
- `/tmp/pw-chrome-profile/` (Playwright 프로필)
- `/tmp/e2e_*.json`, `/tmp/*.png` (테스트 결과)
- LibreOffice 임시 파일: `.~lock.*`, `~$*`

**민감 데이터:**
- game_data.db (라이브 서비스 데이터 복제본일 수 있음 — 사용자에게 확인)
- 사용자/플레이어 식별 가능한 csv/json

### ✅ 커밋 전 필수 체크 (순서대로)

```bash
# 1. 상태 확인 (반드시 먼저)
git status
git diff --stat

# 2. 추적되지 않은 파일 중 의심스러운 것이 있는지
git ls-files --others --exclude-standard | head -30

# 3. .gitignore가 대용량/의존성을 제대로 걸러내는지 확인
du -sh $(git status --porcelain | awk '$1=="??" {print $2}' | head) 2>/dev/null
# 혹은 추가 전에 size 확인:
git diff --cached --stat
```

### ✅ Staging 규칙 (allowlist)

**NEVER** `git add -A`, `git add .`, `git add -u` 자동 실행 금지. 이는 .gitignore 갱신 누락 시 대참사.

대신 **파일을 명시적으로 나열**:
```bash
# 좋음
git add packages/chrome-extension/background/background.js \
        packages/chrome-extension/content/content.js \
        packages/chrome-extension/sidebar/sidebar.js

# 여러 파일일 때만, 확인 후 glob 사용
git add 'packages/chrome-extension/*.js' 'docs/*.md'
```

### ❓ 애매하면 사용자에게

다음 경우는 **커밋 전에 반드시 사용자에게 물어볼 것**:
- 새로 보이는 파일/디렉토리 중 용도가 불명확한 것 (예: `debug/`, `output/`, `reports/` 등)
- 크기가 1MB 넘는 파일 (`*.json`, `*.csv`, `*.db` 등)
- `.claude/` 하위의 새 파일 (skill/agent 파일은 OK, session/cache는 NOT OK)
- `packages/*/` 서브프로젝트 밑의 처음 보는 파일
- Chrome extension `config.js` 등 크레덴셜 가능성 파일

질문 형식:
> "`packages/chrome-extension/tests/*.json` 파일이 새로 생겼는데, 이것이 E2E 테스트 결과로 보입니다. git에 커밋할까요, 아니면 .gitignore에 추가할까요?"

## Commit message conventions

- **형식**: `<type>: <제목 (한국어 또는 영어)>` 한 줄 + 필요시 본문
- **Types**: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `deploy`
- **제목**: 50자 이내, 명령형 ("add/fix/update", "추가/수정/개선")
- **본문**: 왜(why)에 초점. 변경한 내용 나열하지 말 것 (diff가 보여줌)
- **Co-authored 서명**:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

Project K 리포의 기존 커밋 스타일:
```
fix: 수정안 editSession 구조 불일치 — acceptedIds → decisions로 통일
docs: MEMORY.md — 크롬 확장 리뷰 시스템 작업 내역 기록
fix: GameData 검색 — 키 이름 부분 매칭 + 중복 제거
```
→ `type: 한국어 제목 — 부연설명` 패턴을 유지.

나쁜 예:
```
update files
fix bug
WIP
```

## Workflow (표준 진행 순서)

1. **확인**: `git status`, `git diff --stat`로 변경 규모 파악
2. **분류**: 변경을 논리적 단위로 나눔 (여러 커밋이 더 나으면 그렇게)
3. **의심 파일 검토**: untracked 중 build/cache/runtime 의심 파일 없는지
4. **사용자 확인 (애매할 때만)**: AskUserQuestion으로 물어봄
5. **명시적 staging**: `git add <파일 나열>`
6. **staged 확인**: `git diff --cached --stat` → 예상과 일치?
7. **커밋**: HEREDOC으로 메시지 전달
8. **검증**: `git log -1 --stat` + `git status` (clean 확인)

## Push 정책

- **자동 push 금지**: 사용자가 명시적으로 요청해야만
- 사용자가 "push까지 해줘" 말하면 `git push origin master` (force push 금지)
- main branch: `master` (proj-k는 master 사용)

## 본 프로젝트에서 이미 추적 중인 ignored 파일 처리

`git ls-files -ci --exclude-standard`로 현재 **tracked지만 gitignore된** 파일 확인 가능.
이런 파일들을 정리하고 싶을 때:
```bash
# 인덱스에서만 제거, 파일은 유지
git rm -r --cached packages/qna-poc/eval/results/
git commit -m "chore: untrack eval results (moved to .gitignore)"
```
이 작업은 **반드시 사용자 승인 후** 수행.

## Don'ts

- ❌ `git add -A` / `git add .` (allowlist 규칙 위반)
- ❌ `git commit --amend` on pushed commits (히스토리 훼손)
- ❌ `git push --force` (사용자 명시 요청 없이는 절대 금지)
- ❌ `--no-verify`로 pre-commit hook 우회
- ❌ 인증/환경변수 변경을 커밋에 포함 (`git config` 금지)
- ❌ 한 커밋에 너무 많은 무관한 변경 (→ 여러 커밋으로 분리)
- ❌ `lib/config.js` 같은 API 키 포함 파일을 봐도 못 본 척 staging
- ❌ 원본 기획서(`7_System/PK_*.xlsx`)를 리포에 추가

## 체크리스트 (커밋 직전)

- [ ] `git status` 실행했는가?
- [ ] 모든 staged 파일이 의도된 변경인가?
- [ ] `.venv`, `node_modules`, `__pycache__` 등이 staged 되어 있지 않은가?
- [ ] 크레덴셜(`.env`, `*.pem`, `chrome-extension/lib/config.js`)이 포함되지 않았는가?
- [ ] 1MB+ 파일이 있다면 사용자에게 물어봤는가?
- [ ] `_knowledge_base/`, `packages/*/output/` 같은 변환 산출물이 포함되지 않았는가?
- [ ] 원본 기획서(`1_High_Concept/`, `7_System/` 등)가 포함되지 않았는가?
- [ ] 커밋 메시지가 "무엇을" 아닌 "왜"를 설명하는가?
