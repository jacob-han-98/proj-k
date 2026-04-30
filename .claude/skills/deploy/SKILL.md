---
name: deploy
description: "서버 배포 체크리스트 + 안전 가드. '배포', 'deploy', '서버 업데이트', '서버에 올려', '프론트 배포', '백엔드 배포' 등을 요청하면 트리거."
disable-model-invocation: true
---

# 서버 배포

cp.tech2.hybe.im 서버에 백엔드/프론트엔드/Slack 봇을 배포합니다.

**주의**: 베타 테스터가 사용 중인 서버입니다. 반드시 사용자의 명시적 요청이 있을 때만 배포합니다.

## 서버 구성

- **서버**: cp.tech2.hybe.im (Ubuntu, nginx, systemd)
- **접속**: `ssh ubuntu@cp.tech2.hybe.im` (PEM 자동 적용)
- **PEM 키**: `/home/jacob/repos/proj-k/jacob.pem` (권한 600, `*.pem` 으로 gitignore)
- **SSH config** (`~/.ssh/config`): `Host cp.tech2.hybe.im` → `User ubuntu` + `IdentityFile /home/jacob/repos/proj-k/jacob.pem` 자동 적용
- **경로 (qna-poc)**: `/home/ubuntu/proj-k-agent/`
- **경로 (agent-sdk-poc)**: `/home/ubuntu/proj-k-agent/packages/agent-sdk-poc/`
- **서비스**: `proj-k-agent` (qna-poc FastAPI :8088), `proj-k-agentsdk` (agent-sdk-poc), `proj-k-slack-bot` (Socket Mode)
- **프론트 (qna-poc)**: `/home/ubuntu/proj-k-agent/frontend-dist/`
- **프론트 (agent-sdk-poc)**: `/home/ubuntu/proj-k-agent/packages/agent-sdk-poc/frontend/dist/` (nginx alias 가 이 경로 — `frontend-dist/` 가 아님!)
- **ChromaDB**: `/home/ubuntu/.qna-poc-chroma/`

## 배포 절차

### 1. 백엔드 배포

```bash
ssh ubuntu@cp.tech2.hybe.im << 'EOF'
cd /home/ubuntu/proj-k-agent
git pull origin main
source .venv/bin/activate
pip install -r packages/qna-poc/requirements.txt
sudo systemctl restart proj-k-agent
sudo systemctl restart proj-k-slack-bot
sudo systemctl status proj-k-agent proj-k-slack-bot --no-pager
EOF
```

### 2. 프론트엔드 배포

로컬에서 빌드 후 서버에 업로드:

```bash
cd ~/repos/proj-k/packages/frontend
npm run build
scp -r dist/* ubuntu@cp.tech2.hybe.im:/home/ubuntu/proj-k-agent/frontend-dist/
```

### 1.5. agent-sdk-poc 전용 배포

`packages/agent-sdk-poc/` 의 백엔드/프론트는 별도 서비스 (`proj-k-agentsdk`).

**git 기반 (권장 — 우리 commit 워크플로우와 정합)**:
```bash
# 로컬: commit + push
cd ~/repos/proj-k && git push origin master

# 서버: pull + 의존성 + 빌드 + 재시작
ssh ubuntu@cp.tech2.hybe.im << 'EOF'
cd /home/ubuntu/proj-k-agent
git pull origin master
cd packages/agent-sdk-poc
.venv/bin/pip install -q -r requirements.txt
cd frontend && npm run build && cd ..
sudo systemctl restart proj-k-agentsdk
sudo systemctl status proj-k-agentsdk --no-pager | head -10
EOF
```

**rsync 기반 (`deploy/push.sh`) — 주의 필요**:
- push.sh 의 default `DEPLOY_SERVER=jacob@cp.tech2.hybe.im` 는 **잘못됨** (현재 jacob 유저는 publickey 거부, ubuntu 만 됨)
- 사용 시 반드시 envvar override:
  ```bash
  cd ~/repos/proj-k/packages/agent-sdk-poc
  DEPLOY_SERVER=ubuntu@cp.tech2.hybe.im \
    DEPLOY_DIR=/home/ubuntu/proj-k-agent/packages/agent-sdk-poc \
    bash deploy/push.sh
  ```
- `DEPLOY_DIR` 도 절대경로로 명시 (push.sh default `~/proj-k-agent/...` 가 ubuntu 홈으로 expand 되어 의도와 어긋남)

### 1.6. agent-sdk-poc 전용 후처리 — GDD 인덱스 prebuild

`agent-sdk-poc` 의 GDD 도구가 첫 호출 시 cold build (~55s) 발생. deploy 직후 prebuild 권장:

```bash
ssh ubuntu@cp.tech2.hybe.im << 'EOF'
cd /home/ubuntu/proj-k-agent/packages/agent-sdk-poc
.venv/bin/python -c "
import sys; sys.path.insert(0, 'src')
from projk_tools import _build_gdd_index
idx = _build_gdd_index()
print(f'GDD 인덱스: {len(idx[\"meta\"])}개 표, {len(idx[\"by_key\"])} keys')
"
EOF
```

캐시 파일 (`index/_gdd_index.json`) 이 생성되면 이후 콜드 스타트 ~30ms.

### 3. 검증

```bash
ssh ubuntu@cp.tech2.hybe.im << 'EOF'
curl -s http://127.0.0.1:8088/health | python3 -m json.tool
sudo journalctl -u proj-k-agent --since "5 min ago" --no-pager -n 20
sudo journalctl -u proj-k-slack-bot --since "5 min ago" --no-pager -n 20
EOF
```

## 검증 순서 (필수 원칙)

**"서버-만-있는 이슈"가 발생 가능한지부터 먼저 판단한 뒤 검증 장소를 정한다.**

선택 규칙:
1. **로컬에서도 재현되는 성격의 변경**이면 → 반드시 **로컬 선검증 → 배포 → 배포 서버 2차 검증**.
   - 예: 프론트 UI 로직 단독, 단순 렌더링 버그, 유닛 함수 변경.
2. **서버 환경에 의존하는 변경**이면 → **배포 후 서버에서 직접 검증**(로컬 선검증 생략해도 됨).
   - 예: 절대 경로/cwd 가 서버마다 다른 파일 시스템 검증 (`/home/ubuntu/...` vs `/home/jacob/...`), nginx 알리아스·routing, Confluence manifest 경로, systemd 서비스 재시작, Bedrock 크리덴셜, Haiku 요약 파일 존재 여부.
   - 로컬에서 성공해도 **서버 배포 후 반드시 실브라우저/curl 재검증**. curl 200 ≠ 브라우저 200 (URL encoding 차이로 실패한 사례 있음).

이유: 이 프로젝트는 파일 시스템 기반 인덱스(`index/summaries/`, `packages/xlsx-extractor/output/...`)에 강하게 의존. Agent SDK 의 Read 툴은 Python `__file__` 기반 **절대 경로**를 입력으로 사용하므로, 서버에서 `/home/ubuntu/...` 로 시작하는 path 를 프론트로 돌려보낸다. 로컬에서는 `/home/jacob/...` 가 되어 동일 코드가 다른 path 로 호출된다. whitelist 로직/`relative_to` base 순서/nginx alias 오타 같은 이슈는 배포 전 단계에선 절대 잡히지 않는다.

## Gotchas

- **agent-sdk-poc 는 nginx alias 가 `frontend/dist/`**: `frontend-dist/` 로 rsync 하면 서비스되지 않는다 (`snippets/proj-k-agentsdk.conf` 확인). 항상 `frontend/dist/` 로 배포.
- **/source_view 는 whitelist + `relative_to(agent_dir)` 우선**: `relative_to(repo_root)` 을 먼저 쓰면 `packages/agent-sdk-poc/index/...` prefix 가 붙어 403. 순서 중요.
- **curl 은 URL encoding 이슈를 못 잡는다**: `path=<절대경로>` 를 `curl --data-urlencode` 로 돌리면 200 인데, 브라우저 fetch 에서 `+` (공백 인코딩) 로 들어가 다른 경로로 해석되어 403 인 사례. **반드시 Playwright 로 실제 브라우저에서 한 번 더 검증**.
- **Slack 봇도 함께 배포**: 백엔드 배포 시 반드시 `proj-k-slack-bot`도 restart. 안 하면 Slack 멘션이 작동 안 함
- **git pull 전 stash 확인**: 서버에 uncommitted 변경이 있으면 pull 실패. `git stash` 먼저
- **pip install 필수**: requirements.txt 변경 시 빠뜨리면 ImportError로 서비스 crash
- **.env 수동 관리**: 서버의 `.env`는 git에 없음. 새 환경변수 추가 시 수동 편집 필요
- **nginx 설정 변경 시**: `sudo nginx -t && sudo systemctl reload nginx`. 문법 오류면 전체 서비스 다운
- **ChromaDB 재인덱싱**: 서버에는 XLSX 원본이 없음 (Perforce 미설치). Confluence만 인덱싱 가능
- **프론트 빌드 base path**: vite.config.ts의 base가 `/proj-k/`여야 함. `/`로 빌드하면 서버에서 라우팅 깨짐
- **SSE 스트리밍**: nginx에 `proxy_buffering off` 필수. 없으면 실시간 응답이 안 보이고 최종 결과만 한꺼번에 옴
- **포트 8088 고정**: nginx.conf와 systemd 서비스 모두 8088 하드코딩. 바꾸려면 양쪽 다 수정
- **`jacob@cp.tech2.hybe.im` SSH 거부**: 서버는 ubuntu 유저만 등록됨. `jacob@` 시도 시 publickey 거부. 반드시 `ubuntu@` 사용
- **push.sh default 가 잘못된 user 사용**: `jacob@cp.tech2.hybe.im` 와 `~/proj-k-agent/...` (ubuntu 홈으로 expand). 무조건 `DEPLOY_SERVER=ubuntu@... DEPLOY_DIR=/home/ubuntu/...` envvar override
- **agent-sdk-poc 는 frontend 경로가 다름**: nginx alias = `packages/agent-sdk-poc/frontend/dist/`. `frontend-dist/` (qna-poc) 와 혼동 금지
- **GDD 인덱스 cold build 55s**: agent-sdk-poc deploy 직후 위 1.6 prebuild 실행하지 않으면 첫 사용자 GDD 도구 호출이 timeout 위험
- **disable-model-invocation: true**: Claude 자동 invoke 차단. 사용자가 명시적으로 "배포해줘" 한 경우에만 트리거
