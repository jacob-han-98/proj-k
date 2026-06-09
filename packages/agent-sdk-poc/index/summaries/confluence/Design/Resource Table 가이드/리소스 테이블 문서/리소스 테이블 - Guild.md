# 리소스 테이블 - Guild (요약)

> 출처: Design/Resource Table 가이드/리소스 테이블 문서
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Guild/content.md

## 한 줄 설명
길드 시스템의 전체 리소스 테이블 정의. 길드 레벨, 기부, 출석, 보상, 스킬, 미션, 레이드, 제작 등 길드 관련 데이터를 관리하는 15개 시트의 구조와 컬럼 명세.

## 핵심 용어
- GuildLevel
- GuildDonation
- GuildEmblem
- GuildAttendance
- GuildReward
- GuildRandomReward
- GuildSkill
- GuildMission
- GuildMissionProgress
- GuildRaid
- GuildRaidReward
- GuildRaidBuff
- GuildCrafting
- GuildCraftingManufacture
- GuildCraftingMileage
- GuildDonationType
- GuildSkillType
- GuildMissionType
- GuildCraftingCategory
- GuildContentsEnum
- RewardTypeEnum
- CurrencyEnum
- Proto 메시지

## 숫자/상수/공식
- 길드 레벨 Id: 1부터 연속된 정수 (중복 불가)
- 길드 스킬 레벨: 같은 타입 내에서 0부터 연속된 정수
- 미션 Id 최대값: 127 (비트셋 128비트 저장)
- 미션 진행도 Id 최대값: 127 (비트셋 128비트 저장)
- 레이드 부활 대기 시간: 1회 10초, 2회 30초, 3회 이상 60초
- 제작 재료 슬롯: Material01~07 (7개)
- 제작 소요 시간: 1초 이상 (RequireSeconds)

## 참조 시스템
- Buff 테이블
- Item 테이블
- Skill 테이블
- WorldClass 테이블
- Monster 테이블
- WorldVolume 테이블
- shared.md (RewardTypeEnum, CurrencyEnum)
- guild.md (GuildContentsEnum, GuildCraftingCategory, GuildDonationType, GuildMissionType, GuildSkillType)

## 주요 섹션
- 길드 테이블
- 관련 시트
- 테이블 관계도
- 전체 컬럼 사전 (GuildLevel, GuildDonation, GuildEmblem, GuildAttendance, GuildReward, GuildRandomReward, GuildSkill, GuildMission, GuildMissionProgress, GuildRaid, GuildRaidReward, GuildRaidBuff, GuildCrafting, GuildCraftingManufacture, GuildCraftingMileage)
- 사용 Enum 목록
- How-to
- 자주 하는 실수
- 트러블슈팅
