# Chrome Extension - TODO

## 배포 방식 (기능 완성 후 결정)

### 옵션 1: Self-hosted CRX + Windows 인스톨러
- PowerShell 스크립트 또는 Python GUI 인스톨러(.exe)
- Extension 파일을 로컬에 복사 (예: `C:\ProgramData\ProjectK\chrome-extension\`)
- Windows 레지스트리에 Chrome 정책 키 등록 → Chrome 재시작 시 자동 설치
  ```
  HKLM\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist
  값: "<extension-id>;file:///C:/ProgramData/ProjectK/update.xml"
  ```
- 업데이트: 인스톨러가 파일 교체 + 레지스트리 유지 → Chrome 자동 반영
- 장점: 심사 없이 즉시 업데이트, 사용자는 인스톨러만 실행
- 필요: IT팀 협조 (GPO 배포 또는 관리자 권한)

### 옵션 2: Chrome Web Store (비공개/Unlisted)
- Unlisted로 게시 → 링크 아는 사람만 설치
- 자동 업데이트 지원
- 단점: Google 심사 1~3일, 업데이트마다 심사 필요
- 개발자 등록비 $5 일회성

### 옵션 3: Google Workspace 관리자 강제 설치
- Google Admin Console에서 전사/그룹에 자동 배포
- 사용자 개입 없이 설치/업데이트
- 단점: Web Store 업로드 필수 (심사 지연), Workspace Enterprise 필요

### 빌드 스크립트
- `scripts/build.sh` 이미 준비됨 (zip + update.xml 생성)
- CRX 빌드: `./scripts/build.sh --crx` (extension.pem 키 필요)
