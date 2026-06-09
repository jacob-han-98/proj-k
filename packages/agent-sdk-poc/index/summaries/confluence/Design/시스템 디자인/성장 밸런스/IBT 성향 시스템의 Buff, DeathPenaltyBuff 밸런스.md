# IBT 성향 시스템의 Buff, DeathPenaltyBuff 밸런스 (요약)

> 출처: Confluence / PK
> 원본: packages/confluence-downloader/output/Design/시스템 디자인/성장 밸런스/IBT 성향 시스템의 Buff, DeathPenaltyBuff 밸런스/content.md

## 한 줄 설명
IBT 성향 시스템에서 성향별로 적용되는 Buff와 학살 상태 사망 시 누적되는 DeathPenaltyBuff의 밸런스 설정을 정의한다.

## 핵심 용어
- IBT 성향 시스템
- Buff
- DeathPenaltyBuff
- 모범 성향
- 선량 성향
- 타락 성향
- 무법 성향
- 학살 성향
- AllAccuracy
- PvpAllDamage
- CcAllAccuracyRate
- CcAllResistRate
- AllDamage
- AllDamageReduction
- 긍정 성향
- 부정 성향
- 누적

## 숫자/상수/공식
- AllAccuracy: 모범 3, 선량 1, 타락 -1, 무법 -3, 학살 -5
- PvpAllDamage: 모범 0.05, 선량 0.02, 타락/무법/학살 0
- CcAllAccuracyRate: 모범 0.02, 선량 0.01, 타락/무법/학살 0
- CcAllResistRate: 모범/선량 0, 타락 -0.02, 무법 -0.05, 학살 -0.1
- AllDamage: 학살만 -0.05
- AllDamageReduction: 학살만 -0.05
- DeathPenaltyBuff AllDamage: -0.05 (스택당)
- DeathPenaltyBuff AllDamageReduction: -0.05 (스택당)
- DeathPenaltyBuff 최대 중첩: 5

## 참조 시스템
- (없음)

## 주요 섹션
- 현황 분석
- IBT 제안
- Buff
- DeathPenaltyBuff
