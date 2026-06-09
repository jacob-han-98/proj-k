# BonusEnum에 있지만 StatClass에 없는 리스트 (요약)

> 출처: Confluence / Design/시스템 디자인/스킬/스킬 이펙트
> 원본: packages/confluence-downloader/output/Design/시스템 디자인/스킬/스킬 이펙트/BonusEnum에 있지만 StatClass에 없는 리스트/content.md

## 한 줄 설명
BonusEnum에 정의되었으나 StatClass에 미등록된 항목들을 기능별로 분류하고, 보상 스탯으로 편입 가능성을 검토하기 위한 크로스체크 리스트.

## 핵심 용어
- BonusEnum
- StatClass
- ShowUI
- Reward
- Effect
- CC (행동 제어)
- 상태이상
- CC 면역
- 특수 상태 플래그
- Immortal
- TargetableInvincible
- UntargetableInvincible
- Barrier
- BarrierMaxHP
- BarrierAbsorbRate
- PvP 피해 분산
- 스킬 제어
- 버프 메타 파라미터
- 카르마
- 변신
- 공성
- 메타모프

## 숫자/상수/공식
- AllActionDisable: 66
- AllAttackDisable: 67
- MoveDisable: 68
- SkillDisable: 69
- InvokeSkillDisable: 70
- PotionDisable: 71
- TeleportDisable: 72
- Immortal: 73
- TargetableInvincible: 74
- UntargetableInvincible: 75
- Slided: 76
- Spawning: 77
- IgnoreEvade: 78
- Hide: 79
- AdminHide: 80
- IgnoreCollision: 81
- EquippedPetClassID: 82
- RemoveSkill: 83
- AddSkill: 84
- AddHp: 85
- RecoveryHpRate: 86
- SetHp: 87
- SetHpRate: 88
- BarrierMaxHP: 89
- BarrierAbsorbRate: 90
- AddMp: 91
- RecoveryMpRate: 92
- BaseValue: 93
- MaxStat: 94
- InvokeSkillProb: 95
- AddInventorySlot: 96
- AddStorageSlot: 97
- World: 98
- Volume: 99
- Buff: 100
- BuffDuration: 101
- BuffProb: 102
- BuffStackNum: 103
- BuffStack: 104
- RatioPerStack: 105
- ValuePerStack: 106
- SkillCooldownReset: 107
- SkillCostAdjustRate: 109
- ClassId: 110
- MilliSeconds: 111
- AddKarma: 112
- KarmaSlayerClear: 113
- NotIncreaseKarmaToPve: 114
- NotDecreaseKarmaToPvp: 115
- Condition: 116
- BaseLevel: 117
- PerLevel: 118
- MaxLevel: 119
- HighestCombatPoint: 120
- CcAllImmune: 168
- CcStunImmune: 189
- CcHoldImmune: 190
- CcSilenceImmune: 191
- CcPushImmune: 192
- CcPullImmune: 193
- CcSlowImmune: 194
- CcStiffImmune: 195
- CcFrostbiteImmune: 196
- CcFreezeImmune: 197
- CcPotionSealImmune: 198
- AddDamage: 207
- DividePvpDamage_MaxTarget: 213
- DividePvpDamage_Radius: 214
- DividePvpDamage_HpRatioLowerBound: 215
- DividePvpDamage_Ratio: 216
- GuildSkillType: 217
- EquippedSiegeMetamorphClassID: 218
- MetamorphComposeFailLegendary: 219
- MetamorphComposeFailUnique: 220
- MetamorphComposeFailRare: 221
- DamageRateRecoveryHP: 222
- MaxHPRateRecoveryHP: 223
- DamageRateAddDamage: 224
- AlwaysWeaponMaxDamage: 58
- ReachedMaxLevel: 59
- AppliedLevelBaseStatCount: 60
- BonusBaseStatCount: 61
- AppliedBonusBaseStatCount: 62
- AppliedLevelPotentialStatCount: 63
- BonusPotentialStatCount: 64
- AppliedBonusPotentialStatCount: 65

## 참조 시스템
- (없음)

## 주요 섹션
- 행동 제어 / 상태이상
- CC 면역
- 특수 상태 플래그
- HP / MP 직접 조작
- 배리어
- 전투 특수 효과
- PvP 피해 분산
- 스킬 제어
- 버프 메타 파라미터
- 내부 계산 보조값
- 레벨 / 전투력
- 카르마
- 변신 / 공성
- 길드
- 펫
- 인벤토리
- 시스템 / 기타 파라미터
