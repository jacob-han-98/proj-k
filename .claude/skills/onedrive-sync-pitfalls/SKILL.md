---
name: onedrive-sync-pitfalls
description: Klaud 의 OneDrive 경유 Excel-for-Web 임베드 흐름에서 마주치는 함정 모음. 사용자가 "엑셀 본문 안 보여", "빈 워크북", "랜덤하게 보였다 안 보였다", "OneDrive 폴더에서 ✓ 였는데 Klaud 만 stuck", "🔄 영구 sync 상태", "save dialog 떠", "동시 오픈하니 카드 떠" 같은 증상을 보고할 때 트리거. `packages/desktop-app/src/main/onedrive-sync.ts` 또는 `src/renderer/panels/CenterPane.tsx` 의 webview/Excel-for-Web/`?action=` 매개변수/Doc.aspx/`inflight`/concurrency 흐름을 수정할 때도 자동 트리거. 2026-05-04 ~ 2026-05-06 사용자 환경 (BigHit Entertainment / bhunion tenant) 에서 실측 진단으로 도출된 노하우 — 다음 회귀 사이클 때 같은 길을 다시 걷지 않도록 즉시 참조. v6 (단일 직렬 흐름) + v7 (Promise-keyed inflight) 적용 후 안정화.
user-invocable: false
allowed-tools:
  - Bash
  - Read
  - Edit
  - Grep
---

# OneDrive ↔ Excel-for-Web 함정 모음 (Project K)

Klaud 가 P4 → OneDrive → SharePoint → Excel-for-Web 흐름으로 xlsx 를 사용자에게 보여줄 때 마주친 4 단계 chain 의 각 단 별로 비명시적 함정이 있다. 코드 댓글만으로는 잡히지 않는 사용자 환경 / 외부 시스템 (Microsoft, OneDrive Sync, SharePoint) 의 quirks 를 여기에 모은다.

## 핵심 모델 — 4단 릴레이

```
[P4 워크스페이스]
   ↓ ① sidecar HTTP /xlsx_raw                 ← Klaud 책임
[sidecar 메모리 → main 메모리: buf]
   ↓ ② fs 로 OneDrive 폴더 쓰기                 ← Klaud 책임 (이 단의 *방식* 이 함정 1)
[%UserFolder%\OneDrive\Klaud-temp\...]
   ↓ ③ Microsoft OneDrive Sync 엔진             ← 우리가 못 건드리는 영역 (함정 2~3)
[클라우드: bhunion-my.sharepoint.com]
   ↓ ④ Excel-for-Web (Office Online) 이 WOPI 로 fetch  ← 별도 timing/엔드포인트 (함정 4~5)
[사용자 화면]
```

**Klaud 가 직접 통신할 수 있는 건 ① + ② 뿐.** ③ 의 OneDrive Sync 엔진은 Windows 서비스로 별도 동작 — Klaud 는 폴더에 파일 쓰고 SP HEAD 노크해서 결과만 관찰. ④ 의 Excel-for-Web 도 별도 — webview navigation + executeJavaScript 우회로 간접 영향만 가능.

## 함정 1 — `fs.writeFile` 직접 + `utimes(srcMtime)` ⛔

**증상**: 사용자 manual 탐색기 복사는 1-2초만에 ✓ 뜨는데, Klaud 가 만진 파일만 cloud 에서 stuck. local 25MB 가 6148-byte 빈 xlsx 로 자가퇴행. 사용자가 local 에서 삭제하면 1초 안에 6148 bytes 다시 나타남 (OneDrive Sync 가 cloud stub 으로 복원).

**원인** 두 개 결합:
1. `fs.writeFile(destPath, buf)` 으로 OneDrive 폴더에 직접 25MB 쓰면 OneDrive Sync 의 file watcher 가 grow 도중에 여러 번 fire → partial state 보고 conflict resolution 진입
2. `setDestMtime(dest, srcMtimeMs)` 로 mtime 을 P4 commit time (보통 과거) 으로 되돌리면 OneDrive Sync 가 "local 이 cloud stub 보다 옛것" 이라고 판정 → cloud 의 6148-byte stub 을 local 로 다운로드해서 25MB 덮어씀

**Fix 패턴** (`writeViaTempCopy()` in [onedrive-sync.ts:26-49](../../../packages/desktop-app/src/main/onedrive-sync.ts#L26-L49)):

```typescript
// ❌ 옛 (OneDrive Sync 와 충돌)
await writeFile(dest, buf);
await setDestMtime(dest, srcMtimeMs);  // mtime 을 과거로!

// ✅ 새 (Explorer 와 동일 메커니즘)
const tempPath = join(tmpdir(), `klaud-staging-${random}.xlsx`);
await writeFile(tempPath, buf);                 // 임시 폴더에 완성
await mkdir(dirname(destPath), { recursive: true });
await copyFile(tempPath, destPath);             // CopyFileExW (atomic) — Explorer 와 동일 API
await unlink(tempPath).catch(() => {});         // cleanup best-effort
// setDestMtime 호출 X — mtime=NOW 로 두면 OneDrive Sync 가 local 우선시
```

**왜 작동하나**: Node.js `fs.copyFile` 은 Windows 에서 libuv 가 `CopyFileExW` 호출 — Explorer 가 쓰는 정확히 같은 API. atomic 한 번에 완성된 파일이 폴더에 등장 → OneDrive Sync 가 한 번의 "complete file appeared" 이벤트로 인지 → 정상 업로드. mtime=NOW 면 cloud stub 보다 새것이라 local → cloud 방향 sync.

**다음 ensureFresh 의 stale 판정**: mtime 비교 무력화되지만 size 비교가 충분 (xlsx 는 거의 항상 size 다름). `tests/unit/onedrive-sync.test.ts` 의 "stale by size" 테스트가 회귀 방지.

## 함정 2 — `?action=view` / `?action=embedview` direct download 회귀

**증상**: webview 가 빈 화면. 로그에 `[onedrive-session] will-download blocked — url=...?action=view ... mime=...spreadsheetml.sheet` 떠 있음.

**원인**: bhunion-my.sharepoint.com tenant 가 file URL 의 직접 `?action=view` (또는 embedview) 를 webview 안 view 응답이 아니라 **download 응답** (`Content-Disposition: attachment`) 으로 보냄. webview 의 will-download 핸들러가 차단 → 화면 빈 상태로 멈춤. 다른 tenant 는 다르게 동작할 수 있음 (이건 tenant 별 정책/SP 버전 차이).

**Fix 패턴** ([onedrive-sync.ts:91-101](../../../packages/desktop-app/src/main/onedrive-sync.ts#L91-L101) + [CenterPane.tsx redirect intercept](../../../packages/desktop-app/src/renderer/panels/CenterPane.tsx)):

```typescript
// 1. URL builder 는 `?web=1` (SP 가 인정하는 형태)
return `${userUrl}/Documents/Klaud-temp/${rel}.xlsx?web=1`;

// 2. webview did-navigate 리스너에서 SP 의 redirect 결과를 가로채서 swap
if (u.includes('/Doc.aspx') && /[?&]action=default(?:&|$)/.test(u) && !u.includes('action=view')) {
  const viewUrl = u.replace(/([?&])action=default(&|$)/, '$1action=view$2');
  (wv as any).loadURL?.(viewUrl);
}
```

**이유**: `?web=1` → SP 가 정상 redirect 를 `Doc.aspx?sourcedoc={GUID}&file=...&action=default` 로 보냄 (download 회귀 회피). 그 시점에 renderer 가 `action=default` → `action=view` swap → Excel-for-Web 이 view-only 모드로 로드. 두 단계 합쳐 download 회귀 회피 + view 모드 강제 동시 달성.

## 함정 3 — Excel-for-Web edit 모드의 auto-save 가 cloud 를 박살냄

**증상**: 한 번 사용했던 파일이 다음에 클릭하면 빈 워크북. OneDrive 폴더 사이즈가 6148 bytes (정확히 빈 xlsx 사이즈). 사용자 manual 탐색기 복사로 25MB 채워도, Klaud 다시 클릭하면 6148 로 회귀.

**원인 chain**:
1. 옛 코드는 `?web=1` 만 사용 → SP 가 `Doc.aspx?action=default` 로 redirect → Excel-for-Web 이 **edit 모드** 로 로드
2. cloud upload 가 미완료라 Excel 이 incomplete content 받아 "빈 워크북" 으로 렌더
3. Excel-for-Web 의 auto-save 가 그 빈 워크북 상태를 WOPI PUT 으로 cloud 에 저장 → cloud 가 6148-byte stub 으로 영구 corruption
4. 다음 클릭 / 다음 sync: cloud 의 6148 이 local 25MB 를 이김 (함정 1) → 자가퇴행 사이클

**Fix**: 함정 2 의 redirect intercept 가 그대로 cover. action=view 강제하면 Excel-for-Web 이 viewer 모드 → save 위험 없음.

**기존 corruption 청소법** (한 번 corruption 발생하면 코드 fix 만으로 자동 복구 안 될 수 있음):
- 사용자가 [onedrive.live.com](https://onedrive.live.com) 또는 SharePoint 웹 UI 에서 stub 파일 직접 삭제 + 휴지통 비우기
- 또는 코드 fix 적용 후 충분히 큰 sync 1회로 cloud 덮어쓰기 (mtime=NOW 라 local 이 이김)

## 함정 4 — SP HEAD 200 ≠ content readiness

**증상**: `[onedrive-sync] sp-poll ... ready=true status=200` 떴는데 webview 는 빈 워크북. local 에서 25MB 정상 write 후 1초만에 SP 가 200 응답하지만 cloud binary 는 아직 전송 중.

**원인**: SP 의 metadata 레이어 (file URL HEAD) 와 content/binary 레이어 (실제 byte) 는 propagation 타이밍이 다름. metadata 는 OneDrive Sync 가 cloud 에 인식시키자마자 1초 안에 도착 → SP HEAD 200. Binary 는 25MB 업로드라 더 오래 걸림 (~5-30초). Excel-for-Web 의 WOPI fetch 가 그 사이에 일어나면 incomplete content 받음.

**Fix 패턴** (`pollSharePointReady` 강화 in [onedrive-sync.ts:182-263](../../../packages/desktop-app/src/main/onedrive-sync.ts)):

HEAD status=200 응답을 받아도 추가 검증 2개:

1. **Content-Length 가 expectedSize 와 99~101% 매치** — stub (6148 bytes) 와 진본 (25MB) 구분
2. **Range GET `bytes=0-3` 으로 ZIP magic (`PK\x03\x04`) 확인** — xlsx 는 ZIP container 라 첫 4바이트가 시그니처. content 가 진짜 도착했는지 가장 직접적 검증

```typescript
const poll = await pollSharePointReady(account, KLAUD_TEMP_DIR, relPath, {
  expectedSize: buf.length,
  verifyZipMagic: true,
});
// 여전히 ready=false 면 cloud-not-ready event push → renderer 가 inline 에러 카드 + 재시도
```

**중요**: 이 검증은 **status=200 (raw file 응답) 에만** 적용. **`sp-redirect` (302 → Doc.aspx) 는 그대로 trust** — Doc.aspx 는 HTML 이라 ZIP magic 안 나오므로 검증 불가. 302 자체가 "SP metadata 정상" 의미라 신뢰 OK.

## 함정 6 — Set-based inflight + verify-only 짧은 budget = false cloud-not-ready

**증상**: 같은 sheet 두 번 빠르게 클릭 또는 React StrictMode dev 더블파이어 시, 정상 동작 중인 ensureFresh 가 진행 중인데 **별도 카드** 가 떠버림. 로그에 `cloud-not-ready 5651ms attempts=3 lastStatus=404` (5초 budget timeout, 3회 폴링 — 5s verify-only path 의 시그니처).

**원인 chain** (v6 까지):
1. 첫 호출: `inflight.add(relPath)` → 정상 full 흐름 (writeViaTempCopy + 60s poll budget) 시작
2. 두 번째 호출 (StrictMode 또는 rapid double-click): `inflight.has(relPath)` true → "verify-only" 분기 진입 → 짧은 5s HEAD probe
3. 첫 호출의 sidecar fetch + write 가 5s 안에 cloud 까지 못 도달 (대용량 파일 / 네트워크 latency 정상 케이스도 흔함)
4. 두 번째 호출의 5s budget timeout → `status: 'cloud-not-ready'` 반환
5. Renderer 의 cancelled 처리 시점 차이로 두 번째 응답이 active 로 → cloudNotReady 카드 노출
6. 첫 호출은 결국 ready 로 끝나지만 cancelled=true 라 무시됨

**Fix 패턴 (v7)** — `inflight: Set<string>` → `Map<relPath, Promise<EnsureFreshResult>>`:

```typescript
const inflight = new Map<string, Promise<EnsureFreshResult>>();

export async function ensureFreshSync(...) {
  const existing = inflight.get(relPath);
  if (existing) return existing;  // 두 번째 호출자는 첫 번째 Promise 그대로 await

  const promise = doEnsureFreshSync(...);
  inflight.set(relPath, promise);
  try { return await promise; }
  finally { inflight.delete(relPath); }
}
```

**왜 작동하나**: 두 호출자 모두 동일한 Promise 를 await → 동일한 결과 반환. 별도 verify-only path 자체가 없어짐 (race 도 없어짐). progress event 는 첫 호출자의 onProgress 로 main console 까지 흘러서 IPC handler 가 main window 에 broadcast — 두 번째 caller 도 same channel 에서 받음 (filter by relPath in renderer 가 처리).

**다른 사이드 이슈 — 동시 cloud upload bandwidth 한계**: 3 파일 동시 클릭 시 각 ensureFresh 가 각자 writeViaTempCopy 를 마치고 OneDrive Sync 가 동시 업로드. 사용자 실측: 44 + 77 + 96 MB (= 217MB) 동시 업로드 시 96MB 가 60s timeout 안에 cloud 도달 못 함 (`attempts=21 status=200 size=6147` — 옛 stub 가 그대로 보임). 이건 Klaud 가 못 풀어주는 외부 한계. timeout 늘리거나 (`maxMs: 120000`) 사용자 retry 에 의존.

## 함정 7 — 옛 fire-and-forget backgroundSync + cachedUrl 즉시 mount race

**증상**: 작동 중인 webview 가 30초쯤 지나면 갑자기 "OneDrive 동기화 미완료" 카드로 교체됨. 사용자가 보던 본문이 의미 없이 죽음.

**원인 chain** (v5 까지):
1. cachedUrl (옛 매핑) 으로 webview 즉시 mount → SP 가 옛 cloud 본문 응답 → 사용자 본문 보임
2. `backgroundSync` fire-and-forget 으로 새 local 쓰기 + cloud poll
3. Cloud 의 옛 revision 은 **새 local size 와 다름** → poll 의 size-mismatch 검증 실패 → 30s timeout
4. `state: 'cloud-not-ready'` event push → renderer 가 작동 중인 webview 죽이고 카드 노출
5. (옛 v5 임기응변) `excelContentLoadedRef` ref 로 "이미 보고 있으면 무시" 처리 — but 이건 stub 봐도 무시하는 위험

**Fix 패턴 (v6)** — `ensureFreshSync` 단일 직렬 흐름:

```typescript
// 옛 (v5)
ensureFreshSync(...) {
  if (stale) {
    void backgroundSync(...);  // fire-and-forget — race 의 진원지
    return { syncing: true, alreadyFresh: false };
  }
  return { alreadyFresh: true };
}

// 새 (v6)
ensureFreshSync(...) {
  // 모든 단계 await → return 시점엔 이미 결과 결정됨
  if (stale) { await sidecarFetch(); await writeViaTempCopy(); }
  const poll = await pollSharePointReady(...);  // 60s budget
  if (poll.ready) return { status: 'ready' };
  return { status: 'cloud-not-ready', pollAttempts, pollLastStatus };
}
```

**Renderer 측 단순화**: cachedUrl 즉시 mount 흐름, `hadCachedUrlAtMount`, `excelContentLoadedRef`, sub-frame abort count 모두 제거. ensureFresh 결과 (`status` field) 만 보고 webview / 카드 / fallback prompt 분기.

**Trade-off**: 옛 "두 번째 클릭부터 즉시 mount" 빠른 path 가 사라짐. 매 클릭마다 cloud verify-poll (안정 시 100~250ms). 사용자 환경 실측: 무시할 만한 latency.

## 함정 5 — WOPI 엔드포인트는 별도 propagation timing

**증상**: SP file URL HEAD 가 200 + ZIP magic OK 라도 Excel-for-Web 이 빈 워크북으로 렌더. 우리 검증은 통과하는데 사용자는 빈 화면.

**원인**: Excel-for-Web 은 **WOPI** (Web Application Open Platform Interface) 로 파일을 fetch — 우리가 HEAD 노크하는 file URL 과 다른 endpoint:

```
[Klaud HEAD probe]   bhunion-my.sharepoint.com/.../Documents/Klaud-temp/<file>.xlsx
[Excel-for-Web WOPI] bhunion-my.sharepoint.com/.../_vti_bin/wopi.ashx/files/<GUID>/contents
```

같은 SP 테넌트라도 두 endpoint 가 같은 시점에 같은 답을 준다는 보장 없음. WOPI 가 별도 캐시/인덱싱 레이어를 거치면 file URL 검증 통과해도 WOPI 는 늦게 따라옴.

**현재 상태**: 함정 4 의 검증 강화로 사용자 환경에서는 충분히 잡히고 있는 것 확인 (2026-05-04 실측). 만약 함정 4 통과 + 빈 워크북 재발 시:

- **마지막 방어막**: webview `did-finish-load` 후 `executeJavaScript` 로 Excel-for-Web 의 DOM 검사. 워크북에 sheet rows 가 있는지, "Sorry, this workbook is empty" 같은 SP 메시지인지 판별. 빈 placeholder 면 cloud-not-ready 카드로 swap. (현재 미구현 — 필요하면 추가)

## 진단 표준 절차

OneDrive 관련 증상 보고 받으면 이 순서로 들어간다:

### 1. 로그 collector 띄우기
```bash
echo "=== READY ===" > /tmp/klaud-dev.log
OUT=/tmp/klaud-dev.log node packages/agent-sdk-poc/scripts/klaud_log_collector.js &
```

`installLogPush()` 가 `mcpBridgeEnabled !== false` (dev 디폴트) 면 자동으로 `http://localhost:8772/log` 로 main process console 을 POST. 위 collector 가 받아서 file 에 append. **renderer console 도 잡힘** ([src/main/index.ts](../../../packages/desktop-app/src/main/index.ts) `installWebContentsTracing` 가 `type === 'window'` 일 때 console-message → main console forward → log-push).

### 2. 사용자가 dev 재시작 + 문제 클릭

### 3. 로그 grep
```bash
grep -nE "(ensureFresh|sp-poll|write-via-temp|did-navigate|will-download|action=)" /tmp/klaud-dev.log | tail -60
```

### 4. 키 마커로 단계별 격리

| 마커 | 의미 |
|---|---|
| `write-via-temp ... bytes=N (atomic copyFile)` | ② 단계 완료 (local OneDrive 폴더에 파일 등장) |
| `sp-poll-attempt #N status=200 content-length=X` | SP HEAD 도달, content-length 확인 |
| `sp-poll-attempt #N zip-magic bytes=50 4b 03 04 isZip=true` | content 진본 도착 확인 |
| `sp-poll ... ready=true reason=http-200` | ③ 단계 검증 통과 |
| `progress state=cloud-not-ready` | ③ 검증 실패 → renderer 에 카드 노출 신호 |
| `did-navigate url=...?web=1 code=200` | webview ④ 진입 시작 |
| `action=default → action=view swap` | edit→view 전환 성공 (Excel-for-Web 이 view-only) |
| `will-download blocked` | bhunion 의 download 회귀 발동 (URL 파라미터 변경 검토 필요) |

각 마커 부재가 어느 단계에서 멈췄는지 알려준다.

### 5. OneDrive 파일 시스템 상태 직접 검사 (필요 시)

```powershell
# attrib 으로 Files On-Demand 상태 확인
attrib "<path>\*.xlsx"
# Get-Item 으로 mtime / size 정확히
Get-Item "<path>\*.xlsx" | Select-Object Name, Length, LastWriteTime, Attributes
# OneDrive 엔진 자체 상태
Get-Content "$env:LOCALAPPDATA\Microsoft\OneDrive\logs\Business1\SyncDiagnostics.log"
```

`SyncDiagnostics.log` 의 `BytesToUpload`, `FilesToUpload`, `numFileFailedUploads` 가 OneDrive 엔진 입장의 진실. Klaud 의 SP HEAD 와 다를 수 있음.

## OneDrive Files On-Demand 상태 모델 (참고)

탐색기 "상태" 컬럼 아이콘:

| 아이콘 | 이름 | NTFS attrib | 디스크 실체 | 의미 |
|---|---|---|---|---|
| ☁ 파란 클라우드 | Online-only | `0x1420` (OFFLINE 0x1000 + REPARSE 0x400 + ARCHIVE 0x20) | placeholder 0 byte | 열면 동기 다운로드 |
| ✓ 초록 외곽선 | Locally available | `0x420` (REPARSE + ARCHIVE) | 실제 파일 | 즉시 열림. 단 release 가능 |
| ●✓ 꽉 찬 초록 | Pinned | `0x80420` (PINNED 추가) | 실제 파일 | release 안 됨 |
| 🔄 파란 화살표 | Syncing | 없을 수도 (휘발성 UI 상태) | 부분 / 임시 | 변경사항 cloud↔local 전송 중 |
| ⛔ / ! | Error | 다양 | - | 충돌 / 권한 / 용량 |

**중요**: 🔄 가 영구적으로 떠있을 수 있음 — file watcher UI 가 OneDrive Sync 엔진 내부 상태를 lagging 으로 반영하거나, cloud-side 처리 (인덱싱, 바이러스 검사) 가 길어지는 케이스. NTFS attrib 만으로 안 잡히는 transient 상태가 있다는 것 인지.

## 4계층 테스트 전략

OneDrive 관련 코드 변경 시 [packages/desktop-app/CLAUDE.md](../../../packages/desktop-app/CLAUDE.md) 의 4-tier 정책을 따르되 layer 별 한계를 인지:

| Layer | 잡히는 것 | 못 잡히는 것 |
|---|---|---|
| Vitest unit (`tests/unit/onedrive-sync.test.ts`) | mock 된 session.fetch 응답 시퀀스 → state machine 검증 (alreadyFresh / stale / cloud-not-ready / repoll). `__setPollOptionsForTests` 로 timing override. | 진짜 OneDrive Sync 엔진 동작, 실제 SP 응답, WOPI propagation |
| Web e2e (`tests/e2e-renderer/onedrive-sync.spec.ts`) | mock IPC 로 시나리오 A-F. fake `<webview>` 로 mount/unmount/event listener 검증. inline 에러 카드 + 재시도 UX. | 진짜 webview 의 navigation, 진짜 SP redirect, will-download 동작 |
| Real Electron e2e | (이론상) 진짜 환경 검증 가능 | 환경 의존 (사용자 P4 / OneDrive 계정). Poll timeout 강제는 production 코드에 invasive — 자동화 부적합. **manual smoke 가 자연스러움** |
| Manual smoke (사용자) | bhunion tenant 의 download 회귀, Excel-for-Web auto-save, WOPI propagation 등 외부 시스템 quirks | - |

**bug fix → 회귀 테스트 의무**: 새 함정 발견 시 vitest 또는 web e2e 둘 중 적합한 layer 에 시나리오 추가 필수. 예: 함정 1 의 mtime=NOW 정책은 `not.toHaveBeenCalled(utimesMock)` assertion 으로 회귀 차단.

## 용어집

- **WOPI** (Web Application Open Platform Interface): Office Online (Client) 가 외부 호스트 (SharePoint, OneDrive, Box 등) 의 파일을 표준 HTTP API 로 read/write 하는 프로토콜. 핵심 endpoint: `wopi/files/<id>/contents`. [위키](https://en.wikipedia.org/wiki/Web_Application_Open_Platform_Interface)
- **tenant**: 한 클라우드 서비스 (Microsoft 365 등) 안의 격리된 조직 단위. 같은 인프라 위에 회사별 독립 공간. bhunion = BigHit 회사의 SP tenant. tenant 별로 정책 / SP 버전 / 동작 차이 발생 가능 (= 다른 tenant 에서 안 나오는 회귀가 bhunion 에서만 나올 수 있음).
- **stale**: dest (OneDrive 카피본) 가 src (P4 원본) 보다 옛것. 반대말 alreadyFresh.
- **stub** / **placeholder**: 실제 content 없이 metadata 만 있는 파일. OneDrive 의 online-only 는 한 종류, Excel-for-Web 의 빈 워크북 auto-save 결과도 stub (6148 bytes).
- **CopyFileExW**: Windows Win32 API. atomic file copy 의 표준. Explorer 가 쓰는 거. Node.js `fs.copyFile` 이 내부적으로 호출.
- **sp-redirect**: SP 가 file URL 요청에 302 응답하면서 `Doc.aspx?sourcedoc={GUID}` 로 보내는 동작. file 존재 + Office Online 으로 view 안내.
- **http-200 (raw)**: SP 가 file 자체를 직접 200 응답으로 줌. 드물지만 가능. content-length 와 ZIP magic 으로 진본 검증 필수.

## 수정 시 주의

- `?action=*` 매개변수 변경: **반드시 사용자 환경 (bhunion) 에서 실측까지** 확인. unit / web e2e 만으로는 will-download 회귀 못 잡음.
- `setDestMtime` 류 mtime 조작: 절대 금지 — OneDrive Sync 와 정면 충돌. mtime=NOW (writeFile 기본값) 유지.
- `writeFile` 직접 OneDrive 폴더 쓰기 금지: 항상 `writeViaTempCopy()` 경유. atomic copy 가 OneDrive Sync 와 친화적.
- `pollSharePointReady` 의 `verifyZipMagic` 옵션: backgroundSync 등 새로 작성한 파일 검증할 때만 활성. 옛 매핑된 cached URL 을 ensureFresh 하는 alreadyFresh 빠른 path 에서는 짧은 budget (5s) 으로 검증.

## Gotchas (실측 누적)

- **dest=null 인데 `cachedUrl=https://...`** : 옛 매핑이 settings 에 영구 저장돼 있어 LocalSheetView mount 시 cachedUrl 이 채워짐. ensureFresh 가 stale 판정해서 sync 시작하지만 webview 는 이미 cached URL 로 마운트 시도 중. 첫 방문은 SP 404 받고 → sync 완료 후 reloadNonce++ 로 재마운트해서 200 받음. 빈 화면 보고는 안 그래도 아래 함정에 의해.
- **sidecar 가 한국어 P4 path 에서 깨짐**: 로그에 `WinError 267 "디렉터리 이름이 올바르지 않습니다"` 나오면 P4 워크스페이스 root 가 잘못 추정된 것. Klaud 본 sync 와는 무관 (sidecar 트리 빌드 측 회귀).
- **PK_단축키 6KB 회귀**: 함정 1 의 옛 형태. 사이즈 6148 = 빈 xlsx OOXML container 사이즈. 같은 사이즈 파일이 다른 시스템 파일에서 또 보이면 즉시 stub 의심.
- **`installLogPush` 의 8772 collector decommissioned**: 메모리 노트 (`reference_paths_ports.md`) 에는 decommissioned 라고 적혀있지만 dev 디폴트는 여전히 거기로 push. **collector 만 띄워주면 즉시 모든 main + renderer console 받음** — 이번 세션에서 검증된 진단 트릭.
