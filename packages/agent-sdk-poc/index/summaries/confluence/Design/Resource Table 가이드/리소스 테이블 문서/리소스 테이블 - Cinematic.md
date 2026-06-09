# 리소스 테이블 - Cinematic (요약)

> 출처: Confluence / Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Cinematic
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Cinematic/content.md

## 한 줄 설명
게임 내 시네마틱 연출(컷씬, 프리렌더 무비, 풍경 카메라)과 볼륨 진입 시 재생되는 시퀀스를 정의하는 테이블 그룹으로, 텔레포트, 대사 출력 등의 액션을 순서대로 실행한다.

## 핵심 용어
- Cinematic
- CinematicDialog
- VolumeSequence
- VolumeSequenceDialog
- CinematicTypeEnum
- CinematicDialogTypeEnum
- Id (시네마틱 고유 식별자)
- Keyword (시네마틱 식별 키워드)
- Order (액션 실행 순서)
- TeleportWorldId
- TeleportVolumeId
- Teleport 타입 볼륨
- Sequence 타입 볼륨
- PCVisible
- OtherActorVisible
- PlayOnce
- CanSkip
- RelatedSequencer
- DialogString
- DialogType

## 숫자/상수/공식
- 같은 Id 그룹 내 최소 1개 이상의 행 필수
- 같은 시네마틱 Id에 텔레포트 액션 최대 1개만 허용
- Order 숫자가 작을수록 먼저 실행
- 텔레포트 액션은 Order 기준 첫 번째(가장 작은 값)에 위치해야 함

## 참조 시스템
- 월드 테이블 (teleport_world_id, world_id 참조)
- Teleport 타입 볼륨 (teleport_volume_id 참조)
- Sequence 타입 볼륨 (sequence_volume_id 참조)

## 주요 섹션
- 시네마틱 테이블
- 개요
- 관련 시트
- 테이블 관계도
- 전체 컬럼 사전
- Cinematic 시트
- CinematicDialog 시트
- VolumeSequence 시트
- VolumeSequenceDialog 시트
- How-to
- 자주 하는 실수
- 트러블슈팅
