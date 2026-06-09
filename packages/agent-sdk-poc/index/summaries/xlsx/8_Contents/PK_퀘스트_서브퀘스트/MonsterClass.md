# MonsterClass (요약)

> 출처: PK_퀘스트_서브퀘스트 / MonsterClass
> 원본: packages/xlsx-extractor/output/8_Contents/PK_퀘스트_서브퀘스트/MonsterClass/_final/content.md

## 한 줄 설명
Project K의 모든 몬스터 클래스를 정의하는 마스터 데이터 테이블로, 몬스터 ID, 키워드, 도메인 문자열, 레벨, HP, 공격력, 방어력, 어그로 타입 등의 속성을 포함한다.

## 핵심 용어
- MonsterClassID
- Keyword
- domain<type>string
- AggroType (Aggressive, Passive)
- Comment
- DisableUse
- Level
- HP
- Bonus%Used
- EffectStatRatio
- EffectStatID
- MinWeaponAttack
- MaxWeaponAttack
- Defence
- DefenceCounter
- AttackCounter
- MinAttackCounter
- ABDefence
- ABDamage
- 보스 몬스터 (Boss)
- 네임드 몬스터 (Named)
- 인스턴스 던전 몬스터

## 숫자/상수/공식
- MonsterClassID 범위: 1~348 (일반 몬스터), 1001~3022 (보스/네임드)
- Level: 1~70 (SandWorm 계열 단계별 증가)
- HP 예시: 50, 4565, 124269, 1496700, 2747000 (보스 기준 더 큼)
- Bonus% 예시: 300
- 수치 예시: 1000, 2000, 422, 3000, 10, 2250, 1950

## 참조 시스템
- (없음)

## 주요 섹션
- 테이블: 몬스터 클래스 정의
- 일반 몬스터 구간 (ID 1~348)
- 보스/네임드 몬스터 구간 (ID 1001~3022)
- 인스턴스 던전 몬스터 구간
