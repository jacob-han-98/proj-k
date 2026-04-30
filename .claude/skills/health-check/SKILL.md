---
name: health-check
description: "서버 상태 진단 runbook. '서버 상태', '헬스체크', 'health check', '서버 죽었어', '서버 안 돼', '로그 확인', '왜 안 돼' 등을 요청하면 트리거."
---

# 서버 상태 진단

cp.tech2.hybe.im 서버의 전체 상태를 빠르게 점검합니다.

## 진단 순서

### 1. 서비스 상태 확인

```bash
ssh ubuntu@cp.tech2.hybe.im << 'EOF'
echo "=== 서비스 상태 ==="
sudo systemctl status proj-k-agent --no-pager -l
echo "---"
sudo systemctl status proj-k-slack-bot --no-pager -l
echo ""
echo "=== Health endpoint ==="
curl -s --max-time 5 http://127.0.0.1:8088/health | python3 -m json.tool || echo "FAIL: API 응답 없음"
echo ""
echo "=== 최근 에러 로그 ==="
sudo journalctl -u proj-k-agent --since "30 min ago" --no-pager -p err
echo "---"
sudo journalctl -u proj-k-slack-bot --since "30 min ago" --no-pager -p err
echo ""
echo "=== nginx 상태 ==="
sudo systemctl status nginx --no-pager
echo ""
echo "=== 디스크/메모리 ==="
df -h /home/ubuntu
free -h
echo ""
echo "=== ChromaDB 존재 여부 ==="
ls -la /home/ubuntu/.qna-poc-chroma/ 2>/dev/null || echo "ChromaDB 디렉토리 없음"
EOF
```

### 2. 증상별 대응

| 증상 | 원인 | 대응 |
|------|------|------|
| API 502 Bad Gateway | uvicorn 죽음 | `sudo systemctl restart proj-k-agent` |
| API 응답은 오지만 느림 | Bedrock API 지연 | 로그에서 `call_bedrock` 시간 확인 |
| Slack 멘션 무반응 | slack-bot 서비스 죽음 | `sudo systemctl restart proj-k-slack-bot` |
| "Collection not found" | ChromaDB 없음/깨짐 | 서버에서 재인덱싱 필요 |
| 프론트 404 | nginx 설정 or dist 경로 | `ls /home/ubuntu/proj-k-agent/frontend-dist/` |
| SSE 스트리밍 안 됨 | nginx buffering | `proxy_buffering off` 확인 |
| .env 관련 crash | 토큰 만료/누락 | `.env` 파일 내용 확인 (키 값은 출력 금지) |

## Gotchas

- **로그 확인 시 -p err**: 전체 로그는 양이 많으므로 에러 레벨만 먼저 확인. 상세 필요 시 `--since "5 min ago"` 범위 조절
- **ChromaDB lock**: 인덱싱 중 서버가 죽으면 lock 파일이 남을 수 있음. `ls ~/.qna-poc-chroma/*.lock` 확인
- **.env 키 노출 금지**: 진단 중 `.env` 내용을 출력할 때 API 키/토큰 값은 절대 표시하지 말 것. 키 이름만 확인
- **디스크 풀**: ChromaDB + 로그가 디스크를 채울 수 있음. `/home/ubuntu` 사용량 확인
