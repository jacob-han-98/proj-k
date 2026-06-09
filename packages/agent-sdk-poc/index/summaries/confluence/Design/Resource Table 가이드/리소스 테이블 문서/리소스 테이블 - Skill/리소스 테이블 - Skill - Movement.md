# 리소스 테이블 - Skill - Movement (요약)

> 출처: Confluence / 리소스 테이블 - Skill - Movement
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Skill/리소스 테이블 - Skill - Movement/content.md

## 한 줄 설명
Project K의 이동 스킬(Pull, Push, BackDash, Dash) 리소스 테이블 설정 가이드. 각 스킬 타입별 필수/선택 컬럼, Options 파라미터, 설정 방법 및 트러블슈팅을 정의한다.

## 핵심 용어
- Pull
- Push
- BackDash
- Dash
- SkillCategory
- Multiplier
- MaxCount
- Options
- Duration
- Distance
- approach_distance
- CC 저항
- BuffId
- AreaShape
- AnimationName
- ViewRange
- TargetType
- AffectType
- AttackType
- ActiveSkill
- Melee
- Enemy
- Hostile
- Circle

## 숫자/상수/공식
- Options[0] (Duration) 기본값: 500ms
- Options[1] (Distance/approach_distance) 기본값: 없음 (Pull), 100 (Push/BackDash)
- ViewRange: 2400
- Pull 접근 거리: > 0 (선택)
- Push 밀치기 거리: 1 ~ 2400 (필수)
- BackDash 백대시 거리: 1 ~ 2400 (필수)
- Dash 접근 거리: > 0 (선택)
- 예시 스킬 ID: 10205 (Push), 210300 (Dash)
- 예시 Multiplier: 31480 (Push), 19000 (Dash)

## 참조 시스템
- (없음)

## 주요 섹션
- Pull
- Push
- BackDash
- Dash
