# [Beta1] 스킬 이펙트 구현 사항 취합 (요약)

> 출처: Confluence / PK
> 원본: packages/confluence-downloader/output/Design/시스템 디자인/스킬/스킬 이펙트/[Beta1] 스킬 이펙트 구현 사항 취합/content.md

## 한 줄 설명
Beta1 단계에서 클래스별로 구현이 필요한 스킬 이펙트의 목록과 각 효과의 기능 설명, 입력 정보, 적용 대상 클래스를 정의한 문서.

## 핵심 용어
- 발동 액션
- 피격 시
- 무기 최대 대미지 적용
- 명중/크리티컬
- 빈사 상태
- 출혈
- DoT
- 버프 스택 비례
- 버프 스택 부여
- 조건부 효과
- 감속 효과
- 백 대쉬 어택
- 대상 상태에 따른 추가 효과
- 스킬 쿨타임 감소
- 패시브 스킬의 쿨타임
- 버프 종료 후 발동 효과
- 필중 옵션
- 버프 소모형 기본 공격
- 토글 타입 스킬
- 은신
- InvokeConditionEnum
- OnAllDamage
- BonusEnum
- ApplyMaxDamage
- OnLethalDamage
- SetHP
- SetHPRate
- BuffID
- BonusPerStack
- CCtype
- Slow
- CCEnum
- ConditionType
- OverHP
- UnderHP
- InDistance
- OverDistance

## 숫자/상수/공식
- 우선순위: 1, 2, 3, 4(beta2)
- 트랜스 버프 예시: 20스택마다 공격력 1 증가, 크리티컬 확률 1% 증가
- 대상 HP 조건 예시: 70% 이상일 경우 추가 피해 +1
- OnAllDamage = 2

## 참조 시스템
- (없음)

## 주요 섹션
- 클래스 구현에 필요한 스킬 이펙트 리스트
- 백 대쉬 어택
