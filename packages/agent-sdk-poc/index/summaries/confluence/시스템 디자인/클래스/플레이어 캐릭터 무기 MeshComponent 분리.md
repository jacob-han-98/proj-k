# 플레이어 캐릭터 무기 MeshComponent 분리 (요약)

> 출처: 시스템 디자인 / 클래스 / 플레이어 캐릭터 무기 MeshComponent 분리
> 원본: packages/confluence-downloader/output/시스템 디자인/클래스/플레이어 캐릭터 무기 MeshComponent 분리/content.md

## 한 줄 설명
플레이어 캐릭터의 무기를 MeshComponent로 분리하기 위한 무기 타입, 파트 타입, 소켓 매핑, 어셋 설정을 정의한 기술 설계 문서.

## 핵심 용어
- WeaponType
- WeaponPartType
- MeshComponent
- ActiveSocket
- EquipSocket
- EquipOnly
- SkeletalMesh
- 가디언 (Guardian)
- 워리어 (Warrior)
- 아처 (Archer)
- 아발리스터 (Arbalester)
- 매지션 (Magician)
- 샤먼 (Shaman)
- SwordAndShield
- Greatsword
- Bow
- Crossbow
- Staff
- Orb
- Sword
- Shield
- Quiver

## 숫자/상수/공식
- 파츠 수량 = SizeOf(WeaponPartType list) (자동 계산)
- 가디언: 파츠 수량 2
- 워리어: 파츠 수량 1
- 아처: 파츠 수량 2
- 아발리스터: 파츠 수량 1
- 매지션: 파츠 수량 1
- 샤먼: 파츠 수량 1

## 참조 시스템
- 클래스 기본 정보

## 주요 섹션
- 리소스 설정을 위한 무기 구분
- 무기 타입 리스트
- 무기 파트 타입 리스트
- 무기 타입 - 무기 파트 매핑 테이블
- 무기 파트 설정 테이블
- 무기어셋 설정
