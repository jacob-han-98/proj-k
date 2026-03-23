#!/bin/bash
# proj-k 전용 Telegram 봇으로 Claude Code 실행
# 한 머신에서 여러 봇을 띄울 때, 프로젝트별 state 디렉토리로 분리
#
# 사용법:
#   1. scripts/telegram/state/.env 에 봇 토큰 설정
#   2. ./scripts/telegram/start-claude.sh

PROJ_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
STATE_DIR="$PROJ_DIR/scripts/telegram/state"

# state 디렉토리 초기화
mkdir -p "$STATE_DIR/inbox"

# 토큰 확인
if [ ! -f "$STATE_DIR/.env" ]; then
    echo "ERROR: $STATE_DIR/.env 파일이 없습니다."
    echo ""
    echo "  cp scripts/telegram/.env.example $STATE_DIR/.env"
    echo "  그 후 TELEGRAM_BOT_TOKEN 값을 설정하세요."
    exit 1
fi

# access.json 초기화 (없으면)
if [ ! -f "$STATE_DIR/access.json" ]; then
    cat > "$STATE_DIR/access.json" << 'EOF'
{
  "dmPolicy": "pairing",
  "allowFrom": [],
  "groups": {},
  "pending": {}
}
EOF
    echo "access.json 초기화 완료 (pairing 모드)"
fi

echo "proj-k 전용 Telegram 봇으로 Claude Code 시작"
echo "  STATE_DIR: $STATE_DIR"
echo ""

cd "$PROJ_DIR"
TELEGRAM_STATE_DIR="$STATE_DIR" claude --channels plugin:telegram@claude-plugins-official "$@"
