#!/bin/bash
# Project K QnA Agent — 서버 배포 스크립트
# 대상: cp.tech2.hybe.im (SSH + nginx)
# URL: https://cp.tech2.hybe.im/proj-k-agent
#
# 사용법:
#   1. 서버에 SSH 접속
#   2. 이 스크립트가 있는 디렉토리에서 실행: bash setup.sh
#   3. 또는 단계별로 수동 실행 가능

set -e

# ── 설정 ──
APP_DIR="/home/jacob/proj-k-agent"
VENV_DIR="$APP_DIR/.venv"
SERVICE_NAME="proj-k-agent"

echo "=== Project K QnA Agent 배포 ==="

# ── 1. 코드 배포 ──
echo "[1/5] 코드 동기화..."
if [ ! -d "$APP_DIR" ]; then
    echo "  $APP_DIR 디렉토리가 없습니다. git clone 또는 rsync로 먼저 코드를 배치하세요."
    echo "  예: rsync -avz --exclude='.env' --exclude='__pycache__' . jacob@cp.tech2.hybe.im:$APP_DIR/"
    exit 1
fi

# ── 2. Python 가상환경 ──
echo "[2/5] Python 가상환경 설정..."
if [ ! -d "$VENV_DIR" ]; then
    python3 -m venv "$VENV_DIR"
fi
source "$VENV_DIR/bin/activate"
pip install -q -r "$APP_DIR/packages/qna-poc/requirements.txt"

# ── 3. .env 확인 ──
echo "[3/5] 환경변수 확인..."
ENV_FILE="$APP_DIR/packages/qna-poc/.env"
if [ ! -f "$ENV_FILE" ]; then
    echo "  ⚠️  $ENV_FILE 파일이 없습니다!"
    echo "  AWS Bedrock 인증 정보를 설정하세요:"
    echo "    AWS_BEARER_TOKEN_BEDROCK=..."
    echo "    AWS_REGION=ap-northeast-2"
    exit 1
fi
echo "  ✅ .env 파일 확인됨"

# ── 4. ChromaDB 데이터 확인 ──
echo "[4/5] ChromaDB 데이터 확인..."
CHROMA_DIR="$HOME/.qna-poc-chroma"
if [ ! -d "$CHROMA_DIR" ]; then
    echo "  ⚠️  ChromaDB 데이터가 없습니다: $CHROMA_DIR"
    echo "  로컬에서 복사하세요:"
    echo "    rsync -avz ~/.qna-poc-chroma/ jacob@cp.tech2.hybe.im:~/.qna-poc-chroma/"
    exit 1
fi
echo "  ✅ ChromaDB 데이터 확인됨"

# ── 5. systemd 서비스 등록 ──
echo "[5/5] systemd 서비스 설정..."
sudo cp "$APP_DIR/packages/qna-poc/deploy/proj-k-agent.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"

echo ""
echo "=== 배포 완료 ==="
echo "  서비스 상태: sudo systemctl status $SERVICE_NAME"
echo "  로그 확인:   sudo journalctl -u $SERVICE_NAME -f"
echo ""
echo "  nginx 설정 추가가 필요하면:"
echo "    deploy/nginx.conf 의 location 블록을 기존 server 블록에 추가"
echo "    sudo nginx -t && sudo systemctl reload nginx"
echo ""
echo "  URL: https://cp.tech2.hybe.im/proj-k-agent"
