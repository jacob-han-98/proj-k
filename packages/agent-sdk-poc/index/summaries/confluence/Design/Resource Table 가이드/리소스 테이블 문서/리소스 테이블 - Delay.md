# 리소스 테이블 - Delay (요약)

> 출처: Design/Resource Table 가이드/리소스 테이블 문서
> 원본: packages/confluence-downloader/output/Design/Resource Table 가이드/리소스 테이블 문서/리소스 테이블 - Delay/content.md

## 한 줄 설명
캐릭터, 몬스터, 동료의 애니메이션 재생 시간과 스킬 타격 타이밍을 정의하는 테이블로, 공격 속도/스킬 속도 능력치에 따라 자동으로 조정된다.

## 핵심 용어
- AnimationDelay
- SkillAnimationDelay
- AssetName
- AnimationEnum
- Delay
- HitDelay
- FirstProjectileDelay
- ProjectileSpeed
- 속도증감률
- AttackSpeedRate
- SkillSpeedRate
- 발사체
- 비발사체
- 보정 공식
- asset not found
- skill animation delay not found
- 에셋
- 타격 판정
- 애니메이션 재생 시간

## 숫자/상수/공식
- 보정 공식: `실제 딜레이 = 설정값 × 10000 ÷ (10000 + 속도증감률)`
- 기본값(에셋): 1000ms
- 기본값(스킬): delay=1000ms, hit_delay=800ms
- 속도증감률 +5000(+50%): 딜레이 약 67%로 감소
- 속도증감률 -5000(-50%): 딜레이 200%로 증가
- 속도증감률 -10000(-100%) 이하: 동작 수행 불가
- 발사체 히트 딜레이: 보정된 FirstProjectileDelay + (대상까지 거리 ÷ ProjectileSpeed)

## 참조 시스템
- (없음)

## 주요 섹션
- 개요
- 관련 시트
- 테이블 관계도
- 전체 컬럼 사전
- 딜레이 보정 방식
- 발사체 vs 비발사체 판정
- 새 딜레이 추가하기
- 자주 하는 실수
- 트러블슈팅
