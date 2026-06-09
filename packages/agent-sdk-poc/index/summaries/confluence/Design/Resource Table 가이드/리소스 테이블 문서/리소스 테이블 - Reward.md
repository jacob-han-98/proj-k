# 리소스 테이블 - Reward (요약)

> 출처: Confluence / Design/Resource Table 가이드/리소스 테이블 문서
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Reward/content.md

## 한 줄 설명
Project K의 몬스터 처치, 퀘스트, 분해, 길드, 무한의 탑, 월드 이벤트, 연대기, 업적 등 다양한 콘텐츠에서 사용하는 공통 보상 프레임워크를 정의하는 리소스 테이블 가이드.

## 핵심 용어
- 보상(Reward)
- 확률(Probability)
- 랜덤(Random)
- 선택(Select)
- RewardType
- RewardTypeEnum
- ItemId
- Prob
- AmountMin
- AmountMax
- FixedAmount
- CharacterClass
- RewardLimit
- MonsterReward
- QuestReward
- DismantleReward
- GuildReward
- InfiniteTowerFloorReward
- WorldEventRankReward
- ChronologyReward
- AchievementReward
- VoidRiftReward
- VengeanceQuestReward
- RandomRewardClass
- SelectRewardClass
- LimitType
- ResetType

## 숫자/상수/공식
- 확률 기준: 1,000,000 = 100%
- 100% = 1000000
- 50% = 500000
- 10% = 100000
- 1% = 10000
- 0.1% = 1000
- 0.01% = 100
- AmountMin ≥ 1 (유효한 보상 조건)
- Prob ≥ 0 (확률 보상)
- Prob ≥ 1 (랜덤 보상)
- int32 한계: 약 21억 (수량 × 횟수 오버플로 기준)

## 참조 시스템
- MonsterReward.xlsx
- Quest.xlsx
- Dismantle.xlsx
- Guild.xlsx
- InfiniteTower.xlsx
- WorldEvent.xlsx
- Chronology.xlsx
- Achievement.xlsx
- VoidRift.xlsx
- VengeanceQuest.xlsx
- RewardLimit.xlsx

## 주요 섹션
- 보상(Reward) 테이블 개요
- 보상 처리 방식 (확률/랜덤/선택)
- 관련 시트
- 테이블 관계도
- 전체 컬럼 사전
- RewardType별 보상 지급 동작
- 수령 가능 여부 사전 검사
- 새 보상 추가하기 (How-to)
- 자주 하는 실수
- 트러블슈팅
- 참고: 확률 단위
- 참고: 몬스터 보상 드롭률 보너스
