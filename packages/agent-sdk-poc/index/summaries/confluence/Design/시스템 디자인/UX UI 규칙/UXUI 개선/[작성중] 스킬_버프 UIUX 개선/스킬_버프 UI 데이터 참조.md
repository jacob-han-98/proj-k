# 스킬/버프 UI 데이터 참조 (요약)

> 출처: Confluence / Design/시스템 디자인/UX UI 규칙/UXUI 개선/[작성중] 스킬_버프 UIUX 개선/스킬_버프 UI 데이터 참조
> 원본: /home/jacob/proj-k-data/confluence/output/Design/시스템 디자인/UX UI 규칙/UXUI 개선/[작성중] 스킬_버프 UIUX 개선/스킬_버프 UI 데이터 참조/content.md

## 한 줄 설명
Project K의 스킬, 버프, 효과 시스템의 데이터 구조와 UI 표현 규칙을 정의하는 참조 문서로, CharacterSkillClass, BuffClass, EffectClass 세 가지 주요 클래스의 칼럼 정의 및 게임 내 표현 방식을 명시한다.

## 핵심 용어
- CharacterSkillClass
- BuffClass
- EffectClass
- SkillType
- SkillCategory
- SkillGrade
- SkillLevel
- BuffType
- ConditionType
- Effect1, Effect2, Effect3, Effect4, Effect5
- TextkeyTitle
- TextkeyDesc
- IconResource
- AreaShape
- TargetType
- AffectType
- AttackType
- CoolTime
- MpCost
- Multiplier
- Duration
- EffectId
- ShowIcon
- ConditionProb

## 숫자/상수/공식
- 스킬 ID: 100100, 200100, 300100, 9100 (1357개 고유값)
- 스킬 레벨: 0~9 (10단계)
- 버프 ID: 1~1101000 (932개)
- 효과 ID: 5, 15, 1001, 1002, 3002 (858개)
- 데미지 배율(만분율): 15771 (157.71%), 10574 (105.74%), 17850 (178.50%)
- 마나 소모량: 10, 50, 100 (46개 고유값)
- 재사용 대기시간: 0 (없음), 15000ms (15초), 30000ms (30초) (107개 고유값)
- 최소 시전 거리: 130 (근접), 900 (원거리)
- 범위 크기: [700], [500], [300]
- 버프 지속 시간: -1 (무제한), 500~20000ms (31개 고유값)
- 주기적 발동 간격: 1000ms (1초)
- 조건 발동 확률(만분율): 1000 (10%), 2000 (20%), 5000 (50%), 10000 (100%)
- 조건 발동 쿨타임: 10000ms (10초), 30000ms (30초), 60000ms (60초)
- 최대 타격 횟수: 1, 4, 6, 10
- 스킬 우선순위: 1, 3, 11 (13개 고유값)
- 범위 이펙트 크기 배율(만분율): 10000 (100%), 20000 (200%)

## 참조 시스템
- (없음)

## 주요 섹션
- 3.3.3 CharacterSkillClass
- 3.3.4 BuffClass
- 3.3.5 EffectClass
