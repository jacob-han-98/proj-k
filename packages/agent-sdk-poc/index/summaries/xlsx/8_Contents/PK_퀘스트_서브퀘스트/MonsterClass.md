# MonsterClass (요약)

> 출처: PK_퀘스트_서브퀘스트 / MonsterClass
> 원본: packages/xlsx-extractor/output/8_Contents/PK_퀘스트_서브퀘스트/MonsterClass/_final/content.md

## 한 줄 설명
Project K 게임의 몬스터 클래스별 스탯, 속성, 보상 정보를 정의하는 대규모 마스터 데이터 테이블.

## 핵심 용어
- MonsterClassID
- MonsterType
- Grade
- ElementType
- AttackType
- MoveType
- BodySize
- HPBase
- ATKBase
- DEFBase
- HPGrowth
- ATKGrowth
- DEFGrowth
- MoveSpeed
- AttackSpeed
- AttackRange
- DetectRange
- ChaseRange
- EXPReward
- GoldReward
- DropGroupID
- SkillGroupID
- AIType
- SpawnEffect
- DeathEffect
- HitEffect
- ResourcePath
- Index
- Name
- Desc

## 숫자/상수/공식
- 약 200행 이상의 데이터 행
- 약 40~50개 이상의 컬럼
- MonsterClassID 범위: 1001~1500 (추정)
- Index 범위: 1~514 (확인된 최대값)

## 참조 시스템
- (없음)

## 주요 섹션
- 테이블: 몬스터 클래스 정의
- 헤더 구조 (Row 1~2)
- 데이터 행 (Section 1~16/20)
