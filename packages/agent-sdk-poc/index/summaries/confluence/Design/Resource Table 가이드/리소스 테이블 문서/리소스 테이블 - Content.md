# 리소스 테이블 - Content (요약)

> 출처: Design/Resource Table 가이드/리소스 테이블 문서
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Content/content.md

## 한 줄 설명
게임 전역의 콘텐츠 참여 조건, 시스템 설정값, 클라이언트 UI 도움말을 관리하는 리소스 테이블 그룹으로, ContentPrerequisite, ContentSetting, ContentHelp, ContentHelpLink 시트로 구성된다.

## 핵심 용어
- ContentPrerequisite
- ContentSetting
- ContentHelp
- ContentHelpLink
- ContentsTypeEnum
- PlayerConditionEnum
- ContentSettingEnum
- GroupId
- Type
- Arg0, Arg1, Arg2
- PlayerCondition
- Buff
- Land
- ItemGroup
- WindowTypeEnum
- Cron 표현식
- 콘텐츠 참여 조건
- 게임 전역 설정값
- 도움말 내용
- 도움말 연결

## 숫자/상수/공식
- CharacterDeleteWaitDays: 3
- CriticalMinPercent: 0
- CriticalMaxPercent: 100
- CCTimeReductionMinPercentage: 0
- CCTimeReductionMaxPercentage: 10000
- UltimateOpenLevel: 30
- UltimateMaxValue: 10000
- UltimateDecreaseValue: 100
- UltimateDecreaseTimeAtFirst: 30000 (밀리초)
- UltimateDecreaseTimeRepeat: 5000 (밀리초)
- InventoryBaseSlot: 100
- InventoryMaxSlot: 200
- InventoryExtendOnce: 10
- InventoryExtendGold: 10,000
- StorageBaseSlot: 30
- StorageMaxSlot: 100
- StorageExtendOnce: 5
- StorageExtendGold: 100,000
- PartyMaxMemberCount: 4
- PartyRewardShareDistance: 2000
- PartyExtraExpRate: 500
- PartyExtraGoldRate: 1000
- PartyExtraItemDropRate: 500
- KarmaIncreaseExpValue: 7
- KarmaDecreaseBaseValue: 100
- KarmaNewCharacterBaseValue: 1000
- DeathPenaltyApplyMinLv: 10
- DeathPenaltyExpMaxStoreCount: 10
- DeathPenaltyEquipMaxStoreCount: 20
- DefaultReviveDelay: 30 (초)
- FastReviveDelay: 5 (초)
- GuildOpenLevel: 15
- GuildFoundationPrice: 0
- GuildRecommandListMax: 30
- GuildInvitaionMax: 30
- GuildJoinRegisterMax: 30
- GuildNameEditPrice: 0
- GuildHistoryLogMax: 100
- GuildNameWordMin: 0
- GuildWithdrawWaitTime: 48 (시간)
- GuildOfflineDayMax: 14
- GuildAttendanceRateMin: 0.3
- ExchangeTaxBase: 500
- ExchangeSellSlot: 10
- ExchangeFeeGoldPerDia: 10
- ExchangeSellTime: 48시간
- ExchangeHistoryDay: 30
- ExchangeHistoryCount: 100
- ExchangeSearchPageListLimit: 20
- MarketTaxContent1: 0
- MarketTaxContent2: 0
- PetMaxStackAmount: 1000
- TeleportBaseFee: 0
- TeleportFeePerDistance: 0
- TeleportFeeMax: 100,000
- TeleportFeeContinental: 0
- MaxAutoBattleSearchRadius: 40 (미터)
- InfiniteTowerSeasonRewardDelayTime: 10분
- OfflineModeDefaultTime: 8 (시간)
- OfflineModeExtendTime: 16 (시간)
- AutoMaintenanceDefaultTime: 8 (시간)
- AutoMaintenanceExtendTime: 16 (시간)
- MaxComposeFailLegendary: 32
- MaxComposeFailUnique: 128
- MaxComposeFailRare: 512
- DefaultOfflineCharacterSlotCount: 2
- MaxOfflineCharacterSlotCount: 4
- MaxTimeDungeonPaidTime: 9999시간
- MonsterMaxRoamStepDistance: 500
- MonsterRoamIdleTime: 3 (초)

## 참조 시스템
- ContentPrerequisite.xlsx
- ContentSetting.xlsx
- ContentHelp.xlsx
- Buff 테이블
- Land 테이블
- ItemGroup 테이블
- CharacterExp 테이블

## 주요 섹션
- Content 테이블 개요
- 관련 시트
- 테이블 관계도
- 전체 컬럼 사전 (ContentPrerequisite, ContentSetting, ContentHelp, ContentHelpLink)
- ContentSetting 주요 설정 항목 안내 (캐릭터 기본 설정, 전투 관련 설정, 궁극기 관련 설정, 인벤토리/창고 설정, 파티 설정, 성향 설정, 사망 패널티 설정, 길드 설정, 초기화 시간 설정, 몬스터 설정, 거래소/시장 설정, 기타 설정)
- 새 콘텐츠 참여 조건 추가하기
- 새 ContentSetting 항목 추가하기
- 자주 하는 실수
- 트러블슈팅
