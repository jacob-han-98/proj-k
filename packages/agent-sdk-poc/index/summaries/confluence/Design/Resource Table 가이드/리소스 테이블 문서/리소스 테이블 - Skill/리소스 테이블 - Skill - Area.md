# 리소스 테이블 - Skill - Area (요약)

> 출처: Confluence / PK
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Skill/리소스 테이블 - Skill - Area/content.md

## 한 줄 설명
지역 펄스 스킬(PulseAreaAttack, PulseAreaBuff)의 리소스 테이블 설정 가이드. 주기적으로 범위 공격 또는 버프를 적용하는 스킬의 컬럼 정의, Options 구조, 추가 방법, 오류 처리를 정의한다.

## 핵심 용어
- PulseAreaAttack
- PulseAreaBuff
- SkillCategory
- Multiplier
- MaxCount
- AreaShape
- AreaSize
- AffectType
- Options
- AnimationName
- BuffId
- PreBuffId
- interval
- life_time
- zone_buff_id
- Circle
- Rectangle
- Buff 테이블

## 숫자/상수/공식
- 발동 횟수 = life_time / interval
- Options 개수: 2~3개 (필수: interval, life_time; 선택: zone_buff_id)
- Options[0]: 펄스 간격 (ms), > 0
- Options[1]: 총 지속시간 (ms), > 0, >= interval
- Options[2]: 지역 버프 Id (선택)
- 예시: interval=1000, life_time=5000 → 5회 발동

## 참조 시스템
- Buff 테이블

## 주요 섹션
- PulseAreaAttack
- PulseAreaBuff
