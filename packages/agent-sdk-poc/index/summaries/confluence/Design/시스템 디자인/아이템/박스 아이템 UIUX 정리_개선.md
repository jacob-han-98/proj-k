# 박스 아이템 UIUX 정리/개선 (요약)

> 출처: Confluence / Design/시스템 디자인/아이템/박스 아이템 UIUX 정리_개선
> 원본: packages/confluence-downloader/output/Design/시스템 디자인/아이템/박스 아이템 UIUX 정리_개선/content.md

## 한 줄 설명
소모품 아이템 중 ItemBoxId로 묶인 박스 아이템의 정보 팝업 UI/UX 구성과 재화 아이템 정보 팝업 추가 요소를 정의하는 문서.

## 핵심 용어
- ItemBoxId
- ItemConsumeClass
- ItemRewardBox
- ItemRandomBox
- ItemSelectBox
- ItemReward
- ItemRandom
- ItemSelect
- ConsumeType
- EnchantLevel
- FixedAmount
- CanAuction
- CanDelete
- CanSell
- ConditionClass
- ConditionMinLv
- ConditionMaxLv
- ExpireTime
- TextKeyTitle
- TextKeyDesc
- IconResource
- Prob
- RewardType
- Metamorph
- Pet
- Grade
- 귀속
- 확률 정보 모달
- 아이템 획득 팝업

## 숫자/상수/공식
- 소수점 4자리까지 확률 표현
- 유효 일자 24시간 전: 붉은 색 표기
- 아이템 획득 팝업 우선순위: 타입(Currency > Equip > Consume > Etc) > 등급(Epic > Myth > Legendary > Unique > Rare > Uncommon > Common) > 귀속 여부(CanAuction:TRUE > FALSE) > 수량(많은 > 적은) > ID(오름차순)

## 참조 시스템
- 아이템 UIUX 정리/개선
- 인벤토리 UIUX 개선
- Common Widget

## 주요 섹션
- 문서 목적
- 공통 규칙
- 테이블 구조
- ItemBox
- 시스템 메시지
- 데이터
