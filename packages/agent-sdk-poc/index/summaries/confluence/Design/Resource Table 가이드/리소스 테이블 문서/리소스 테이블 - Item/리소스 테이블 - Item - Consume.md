# 리소스 테이블 - Item - Consume (요약)

> 출처: Confluence / PK
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Item/리소스 테이블 - Item - Consume/content.md

## 한 줄 설명
Project K의 소비(Consume) 아이템 설정 방법과 ConsumeType별 동작 가이드를 정의하는 리소스 테이블 문서.

## 핵심 용어
- Consume
- ConsumeType
- ItemType
- BuffId
- ItemBoxId
- Value01
- Value02
- Grade
- MaxStack
- ConditionClass
- ConditionMinLv
- ConditionMaxLv
- CoolTimeGroupId
- Cooltime
- Potion
- Cook
- RechargeTime
- Teleport
- TeleportTown
- TeleportRandom
- ItemRandomBox
- ItemChoiceBox
- SkillBook
- AddKarma
- SlayerClear
- TimedAccess
- ExtendOfflineCharacterSlot
- PotionDisable
- CanInstanceUse
- CanMoveServerUse
- CanAuction
- CanDelete
- CanLock
- CanStorage
- CanSell
- SellPrice
- ExpireTime
- ItemReward
- ItemSelect
- TimedAccessEnum
- 랜드 ID
- 볼륨 ID

## 숫자/상수/공식
- 사용 조건 확인 → 쿨타임 확인 → 아이템 수량 차감 → 버프 적용 → ConsumeType별 고유 동작 실행 (순서)
- RechargeTime: 실제 변화량 = Value02 × 사용 수량 (초 단위)
- AddKarma: 실제 변화량 = ItemBoxId × 사용 수량
- RechargeTime Value02 최소값: 1초 이상 필수
- TimedAccess Value02 최소값: 1일 이상 필수
- MaxStack 최소값: 0 이상 (0 설정 시 에러)

## 참조 시스템
- Item.xlsx (ItemConsumeClass 시트)
- ItemReward 테이블
- ItemSelect 테이블
- TimedAccessEnum

## 주요 섹션
- 설정할 컬럼
- 공통 동작
- ConsumeType별 설정 가이드
- 새 소비 아이템 추가하기
- 실제 예시
- 자주 하는 실수
- 트러블슈팅
