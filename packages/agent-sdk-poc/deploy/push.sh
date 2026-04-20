#!/bin/bash
# Project K · Agent SDK 로컬→서버 배포 스크립트
#
# 역할:
#   1. 로컬에서 Node 20(nvm) 으로 frontend production build
#   2. 서버로 backend / scripts / overlay schema / frontend dist rsync
#   3. 서버에서 pip install (신규 의존성 반영) + systemd restart
#
# 사전:
#   - 서버 SSH 접근 가능 (rsync, ssh 통과)
#   - 서버에 기존 배포가 이미 완료되어 있어야 함 (venv, .env, 인덱스, 코퍼스)
#   - `sudo systemctl ...` NOPASSWD 또는 동등 권한
#
# 환경변수로 서버/경로 덮어쓰기 가능:
#   DEPLOY_SERVER=jacob@cp.tech2.hybe.im
#   DEPLOY_DIR=~/proj-k-agent/packages/agent-sdk-poc
#   SERVICE_NAME=proj-k-agentsdk

set -euo pipefail

SERVER="${DEPLOY_SERVER:-jacob@cp.tech2.hybe.im}"
REMOTE_POC="${DEPLOY_DIR:-~/proj-k-agent/packages/agent-sdk-poc}"
SERVICE_NAME="${SERVICE_NAME:-proj-k-agentsdk}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POC_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$POC_DIR"

echo "=== [1/4] frontend build (Node 20) ==="
if command -v nvm >/dev/null 2>&1; then
  :  # already available
elif [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh"
else
  echo "  ⚠️  nvm 이 없습니다. Node 20+ 환경에서 직접 build 해주세요."
  echo "     (cd frontend && npm run build)  후 [2/4] 단계부터 다시 실행."
  exit 1
fi
nvm use 20 >/dev/null
node -v

(cd frontend && npm run build)

if [ ! -f "frontend/dist/index.html" ]; then
  echo "  ❌ frontend/dist/index.html 가 생성되지 않았습니다. build 실패."
  exit 1
fi

echo ""
echo "=== [2/4] rsync backend + overlay schema ==="
# 최초 배포라면 decisions/ 하위 폴더가 없을 수 있음 — 미리 준비
ssh "$SERVER" "mkdir -p $REMOTE_POC/decisions/{schema,config,_history,_perf} $REMOTE_POC/static" 2>/dev/null || true
# Backend 파이썬 소스 (__pycache__·.venv 제외)
rsync -avz --delete \
  --exclude='__pycache__' --exclude='*.pyc' \
  src/ "$SERVER:$REMOTE_POC/src/"

# 실행 스크립트 (rank_refactor_targets, audit_citations, decision_cli 등)
rsync -avz --delete \
  --exclude='__pycache__' \
  scripts/ "$SERVER:$REMOTE_POC/scripts/"

# 의존성 변경 가능성 있으면 requirements도
rsync -avz requirements.txt "$SERVER:$REMOTE_POC/requirements.txt"

# Overlay 스키마 · rubric · README (사용자 데이터 파일은 제외)
rsync -avz --delete decisions/schema/ "$SERVER:$REMOTE_POC/decisions/schema/"
rsync -avz --delete decisions/config/ "$SERVER:$REMOTE_POC/decisions/config/"
rsync -avz decisions/.gitignore decisions/README.md \
  "$SERVER:$REMOTE_POC/decisions/"

echo ""
echo "=== [3/4] rsync frontend dist -> static ==="
rsync -avz --delete frontend/dist/ "$SERVER:$REMOTE_POC/static/"

echo ""
echo "=== [4/4] pip install + systemd restart ==="
ssh "$SERVER" bash <<REMOTE
set -e
cd "$REMOTE_POC"
# Python 의존성 신규 (예: jsonschema) 반영
.venv/bin/pip install -q -r requirements.txt
# 서비스 재시작
sudo systemctl restart "$SERVICE_NAME"
sleep 2
sudo systemctl status "$SERVICE_NAME" --no-pager | head -12
echo ""
echo "최근 로그:"
sudo journalctl -u "$SERVICE_NAME" -n 10 --no-pager
REMOTE

echo ""
echo "=== 배포 완료 ==="
echo "  URL: https://cp.tech2.hybe.im/proj-k/agentsdk/"
echo "  Admin: https://cp.tech2.hybe.im/proj-k/agentsdk/admin"
echo "  로그:  ssh $SERVER 'sudo journalctl -u $SERVICE_NAME -f'"
