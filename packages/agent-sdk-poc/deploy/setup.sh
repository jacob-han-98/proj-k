#!/bin/bash
# Project K Agent SDK — 서버 배포 스크립트
# 대상: cp.tech2.hybe.im (SSH + nginx)
# URL:  https://cp.tech2.hybe.im/proj-k/agentsdk
#
# 준비:
#   - 서버에 SSH 접속 후 이 디렉터리로 이동
#   - (또는 로컬에서 rsync 후 서버에서 실행)

set -e

APP_DIR="/home/jacob/proj-k-agent"
POC_DIR="$APP_DIR/packages/agent-sdk-poc"
VENV_DIR="$POC_DIR/.venv"
SERVICE_NAME="proj-k-agentsdk"

echo "=== Project K · Agent SDK 배포 ==="

# ── 1. 코드 존재 확인 ──
echo "[1/6] 코드 배치 확인..."
if [ ! -d "$POC_DIR" ]; then
    cat <<EOF
  $POC_DIR 디렉터리가 없습니다. 먼저 로컬에서 rsync 하세요:

    rsync -avz --exclude='.venv' --exclude='__pycache__' --exclude='.env' \\
      packages/agent-sdk-poc/ jacob@cp.tech2.hybe.im:$POC_DIR/

  코퍼스는 별도 rsync:
    rsync -avz --delete /mnt/e/proj-k-data/xlsx-extractor/output/ \\
      jacob@cp.tech2.hybe.im:$APP_DIR/packages/xlsx-extractor/output/
    rsync -avz --delete /mnt/e/proj-k-data/confluence/output/ \\
      jacob@cp.tech2.hybe.im:$APP_DIR/packages/confluence-downloader/output/

  KG:
    rsync -avz _knowledge_base/knowledge_graph.json \\
      jacob@cp.tech2.hybe.im:$APP_DIR/_knowledge_base/
EOF
    exit 1
fi

# ── 2. venv ──
echo "[2/6] Python 가상환경 설정..."
if [ ! -d "$VENV_DIR" ]; then
    python3 -m venv "$VENV_DIR"
fi
source "$VENV_DIR/bin/activate"
pip install -q -r "$POC_DIR/requirements.txt"

# ── 3. .env ──
echo "[3/6] 환경변수 확인..."
ENV_FILE="$POC_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
    echo "  ⚠️  $ENV_FILE 가 없습니다. AWS_BEARER_TOKEN_BEDROCK 설정 필요."
    echo "  .env.example 참조."
    exit 1
fi

# ── 4. 인덱스 파일 확인 ──
echo "[4/6] 인덱스 파일 확인..."
if [ ! -f "$POC_DIR/index/MASTER_INDEX.md" ]; then
    echo "  ⚠️  MASTER_INDEX.md 가 없습니다."
    echo "  로컬에서 빌드 후 rsync 또는 서버에서 재빌드:"
    echo "    python scripts/build_all.py --all --workers 15"
    exit 1
fi

# ── 5. systemd ──
echo "[5/6] systemd 등록..."
sudo cp "$POC_DIR/deploy/proj-k-agentsdk.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"

# ── 6. 상태 ──
echo "[6/6] 서비스 상태..."
sleep 2
sudo systemctl status "$SERVICE_NAME" --no-pager | head -15

echo ""
echo "=== 배포 완료 ==="
echo "  URL:   https://cp.tech2.hybe.im/proj-k/agentsdk/"
echo "  로그:  sudo journalctl -u $SERVICE_NAME -f"
echo ""
echo "  nginx 반영이 필요하면 deploy/nginx.conf.snippet 참고."
