#!/usr/bin/env bash
# OnlyOffice DS 멱등 bring-up (AI-TEST-02, headless 변환용).
#
# 하는 일:
#   1. compose up -d (한글 폰트 baked-in custom image build/run)
#   2. healthcheck 대기
#   3. local.json 에 request-filtering-agent.allowPrivateIPAddress merge
#      (변환 API 가 host.docker.internal=사설IP 로 파일 fetch 하려면 필수.
#       컨테이너 기동마다 env 기반으로 local.json 이 재생성되므로 매번 재적용)
#   4. 서비스 재시작 + healthcheck 재확인
#
# 사용: bash packages/excel-viewer-poc/oo-up.sh
set -euo pipefail
cd "$(dirname "$0")"

DC="sudo docker compose"
CN="onlyoffice-ds-poc"
URL="${PROJK_ONLYOFFICE_URL:-http://localhost:8080}"

echo "[oo-up] compose up -d (build if needed)..."
$DC up -d --build

wait_health() {
  for i in $(seq 1 40); do
    if [ "$(curl -fsS -m 3 "$URL/healthcheck" 2>/dev/null)" = "true" ]; then
      echo "[oo-up] healthcheck OK (t+$((i*3))s)"; return 0
    fi
    sleep 3
  done
  echo "[oo-up] healthcheck TIMEOUT"; return 1
}

echo "[oo-up] waiting for DS..."; wait_health

echo "[oo-up] merge allowPrivateIPAddress into local.json..."
sudo docker exec -i "$CN" python3 - <<'PY'
import json
p = "/etc/onlyoffice/documentserver/local.json"
d = json.load(open(p))
co = d.setdefault("services", {}).setdefault("CoAuthoring", {})
rfa = co.get("request-filtering-agent")
want = {"allowPrivateIPAddress": True, "allowMetaIPAddress": True}
if rfa == want:
    print("  already set")
else:
    co["request-filtering-agent"] = want
    json.dump(d, open(p, "w"), indent=2)
    print("  merged")
PY

echo "[oo-up] merge FileConverter 입력 한계 상향 (대용량 8_Contents xlsx)..."
sudo docker exec -i "$CN" python3 - <<'PY'
import json
p = "/etc/onlyoffice/documentserver/local.json"
dp = "/etc/onlyoffice/documentserver/default.json"
d = json.load(open(p))
il = json.load(open(dp))["FileConverter"]["converter"].get("inputLimits", [])
for e in il:
    if "xlsx" in e.get("type", ""):
        e["zip"]["uncompressed"] = "1024MB"
fc = d.setdefault("FileConverter", {}).setdefault("converter", {})
fc["maxDownloadBytes"] = 524288000   # 100MB → 500MB (아트 임베드 대형 xlsx)
fc["inputLimits"] = il
json.dump(d, open(p, "w"), indent=2)
print("  maxDownloadBytes=500MB, xlsx uncompressed=1024MB")
PY

echo "[oo-up] restart DS services..."
sudo docker exec "$CN" supervisorctl restart all >/dev/null
wait_health
echo "[oo-up] ready: $URL"
