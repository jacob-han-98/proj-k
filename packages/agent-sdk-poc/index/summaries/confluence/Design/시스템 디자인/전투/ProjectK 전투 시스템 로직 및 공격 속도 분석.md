# ProjectK 전투 시스템 로직 및 공격 속도 분석 (요약)

> 출처: Confluence / ProjectK
> 원본: packages/confluence-downloader/output/Design/시스템 디자인/전투/ProjectK 전투 시스템 로직 및 공격 속도 분석/content.md

## 한 줄 설명
ProjectK의 전투 시스템에서 캐릭터와 몬스터의 공격 속도, 스킬 우선순위, 행동 순서를 결정하는 데이터 구조와 로직을 정의한 문서.

## 핵심 용어
- AttackSpeedRate
- SkillSpeedRate
- Priority
- CharacterSkillClass.json
- MonsterSkillClass.json
- MetamorphStatGroup.json
- BattleObjectTypeRelation.json
- MonsterBase.json
- MonsterClass.json
- BossRaidClass.json
- MetamorphGradeInfo.json
- NormalAttack
- ActiveSkill
- SkillCategory
- CoolTime
- Multiplier
- AnimationName
- BattleObjectType
- PassivePC
- AggressivePC
- MaxCount
- Phase
- Metamorph

## 숫자/상수/공식
- AttackSpeedRate 기본값: 1500-8500 (1500 = 100% 기준)
- 일반 등급: AttackSpeedRate 1500, SkillSpeedRate 1500
- 고급 등급: AttackSpeedRate 2500, SkillSpeedRate 2500
- 희귀 등급: AttackSpeedRate 4000, SkillSpeedRate 4000
- 영웅 등급: AttackSpeedRate 6000, SkillSpeedRate 6000
- 전설 등급: AttackSpeedRate 8500, SkillSpeedRate 8500
- Priority: 1 (높은 우선순위, 숫자가 낮을수록 먼저 실행)
- CoolTime: 0 (기본 공격)
- MaxCount: 1 (순차 실행), MaxCount > 1 (동시 사용 가능)
- MoveSpeedBattle: 320
- MoveSpeedPeace: 200
- RotationSpeed: 720
- StartTime: 60초 (레이드 시작 대기시간)
- EndTime: 480초 (최대 레이드 지속시간)
- EnterMaxCharacter: 50명
- 최종 공격 속도 = (AttackSpeedRate / 1000) * AnimationPlayRate
- 실제 턴 시간 = 애니메이션 재생 길이 / 최종 공격 속도

## 참조 시스템
- (없음)

## 주요 섹션
- 요약
- 기본 공격 (공격 속도 제어)
- 액티브 스킬 (우선순위 & 동시 사용)
- 전투 시 캐릭터 행동 우선순위 (PC & 몬스터)
- 네임드/보스 몬스터 스킬 세팅
- 메타모프(변신) 등급별 공격속도
- 애니메이션 속도 vs 실제 공격 속도
