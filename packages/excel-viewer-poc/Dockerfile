# OnlyOffice DS + 한글 폰트 baked-in (변환 시 한글 깨짐 방지).
# request-filtering-agent.allowPrivateIPAddress 는 컨테이너 기동 후 env 기반으로
# local.json 이 재생성되므로 Dockerfile 에 못 박지 못함 → oo-up.sh 가 기동 후 merge.
FROM onlyoffice/documentserver:latest

RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-noto-cjk fonts-nanum \
    && rm -rf /var/lib/apt/lists/*

# Windows 한국어 폰트명(맑은 고딕/돋움 등) → Noto CJK KR 별칭.
# 없으면 라틴 DejaVu 로 대체되어 열폭 계산이 어긋나 흐름도 연결선이 노드에서 떨어짐.
COPY fonts-local.conf /etc/fonts/local.conf
RUN fc-cache -f
