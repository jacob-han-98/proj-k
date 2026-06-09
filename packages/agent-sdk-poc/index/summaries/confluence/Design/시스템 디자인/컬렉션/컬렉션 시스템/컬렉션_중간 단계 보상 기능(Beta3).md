# 컬렉션_중간 단계 보상 기능(Beta3) (요약)

> 출처: PK / 컬렉션_중간 단계 보상 기능(Beta3)
> 원본: packages/confluence-downloader/output/Design/시스템 디자인/컬렉션/컬렉션 시스템/컬렉션_중간 단계 보상 기능(Beta3)/content.md

## 한 줄 설명
컬렉션 달성 시간이 오래 걸릴 경우 유저 흥미 저하를 완화하기 위해 중간 단계 보상을 추가하는 기능으로, ItemCollectionClass 테이블에 PartialCount와 PartialEffectStat 컬럼을 추가하여 구현한다.

## 핵심 용어
- ItemCollectionClass
- PartialCount
- PartialEffectStat
- PartialEffectStatName
- PartialEffectStatValue
- TargetItem
- ItemCount
- BonusEnum
- CollectionCategoryEnum
- Equipment
- Collectable
- Achievement
- Skill
- Event
- IsTimeLimited
- ItemEquipClass
- CanEnchant
- 중간 달성 단계
- 진행 단계 표시
- 아이템 그룹

## 숫자/상수/공식
- TargetItem 개수: 01~06 (최대 6개)
- PartialEffectStat 개수: 01~02 (최대 2가지)
- EffectStatName 개수: 01~03 (최대 3개)
- Category 값: Equipment=1, Collectable=2, Achievement=3, Skill=4, Event=5
- IsTimeLimited 값: 0 또는 빈칸=X, 1=O
- PartialCount 조건: TargetItem 종류 > PartialCount (위반 시 에러 처리)
- ItemCount 조건 (장비): 무조건 1개, 1 이상 시 서버 에러 처리
- ItemCount 조건 (비장비): 1 이상 기입 가능, 0 또는 빈칸 시 서버 에러 처리

## 참조 시스템
- ItemEquipClass
- ItemCollectionClass
- EventScheduler 테이블 (기간제 컬렉션 관련, Beta1 이후 진행 예정)

## 주요 섹션
- 개요
- 개선 방향
- UI
- 진행 단계 표시 영역
