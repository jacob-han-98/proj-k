# 리소스 테이블 - Player (요약)

> 출처: Confluence / Design/Resource Table 가이드/리소스 테이블 문서
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Player/content.md

## 한 줄 설명
캐릭터의 기본 정보, 레벨업 스탯 성장, 경험치 테이블, 능력치 정의를 관리하는 플레이어 리소스 테이블 그룹으로, 직업별 기본 능력치, 레벨 구간별 스탯 보너스, 레벨별 필요 누적 경험치, 게임 내 모든 능력치의 동작 방식과 전투력 환산 계수를 정의한다.

## 핵심 용어
- CharacterClass
- CharacterLevelUp
- CharacterExp
- StatClass
- BonusEnum
- CharacterClassEnum
- TribeEnum
- EquipPartsEnum
- NumberTypeEnum
- OperationEnum
- StatCategoryEnum
- MaxHp
- BaseHp
- MaxMp
- BaseMp
- Str, Dex, Con, Int, Wis
- LevelStart, LevelEnd
- ApplyType
- StatName, StatValue
- TotalExp
- Operation
- GroupName
- ValuePerPoint
- NumberOfPoints
- MaxValue
- CombatPoint
- CombatPointClass

## 숫자/상수/공식
- StatName1~5: 최대 5개 슬롯
- SignatureSkill01~04: 대표 스킬 4개
- 연관 스탯 계산 공식: 상위 능력치 값 ÷ NumberOfPoints × ValuePerPoint
- CombatPoint 계산: Operation이 Percent가 아닌 경우 100을 곱하여 적용
- NumberOfPoints 유효 범위: 1 이상 (0이면 자동으로 1로 처리)
- MaxValue: 0이면 상한 없음, 1 이상이면 해당 값이 상한
- Level 유효 범위: 1 이상 (연속된 값이어야 함)
- TotalExp 유효 범위: 0 이상 (레벨이 올라갈수록 값이 증가해야 함)

## 참조 시스템
- Character.xlsx (CharacterClass, CharacterLevelUp, CharacterExp 시트)
- StatClass.xlsx (StatClass 시트)
- Metamorph 테이블

## 주요 섹션
- 플레이어 테이블
- 개요
- 관련 시트
- 테이블 관계도
- 전체 컬럼 사전
- CharacterClass 시트
- CharacterLevelUp 시트
- CharacterExp 시트
- StatClass 시트
- 새 데이터 추가 방법
- 자주 하는 실수
- 트러블슈팅
