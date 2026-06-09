# 전환 UI FLOW 규칙 설정 (요약)

> 출처: Confluence / 전환 UI FLOW 규칙 설정
> 원본: packages/confluence-downloader/output/Design/시스템 디자인/UX UI 규칙/UX 규칙 문서/전환 UI FLOW 규칙 설정/content.md

## 한 줄 설명
게임의 반복적인 콘텐츠 경험에서 유저 피로도를 최소화하고 성취감을 극대화하기 위해 화면 전환의 통합된 UX FLOW를 정의하는 문서.

## 핵심 용어
- Info Flow (정보 전환)
- Content (콘텐츠 진입)
- Result (결과 연출)
- System (시스템 제어)
- Transition Types (전환 방식 분류)
- UI 전환 통합 규칙
- 팝업
- 풀페이지 UI
- 결과 리포트
- 인스턴스 던전
- 보상 획득
- 예측 가능성
- 즉각적 피드백
- 성취 몰입도
- 공통 전환 라이브러리
- Slide 전환
- Fade-in
- Alpha
- 인터렉션 락
- 로딩 루프
- Zoom-in & FX
- 포커스 라이트
- 파티클 폭발
- 글로우 (Glow)
- 등급 표시

## 숫자/상수/공식
- Info Flow: 0.25s ~ 0.3s (고정)
- Content: 0.45s ~ 0.55s
- Result: 0.8s
- System: 가변 시간
- Result 1단계: 0.0~0.3s (화면 암전)
- Result 2단계: 0.3~0.5s (핵심 결과 노출)
- Result 3단계: 0.5~0.8s (텍스처 강조)
- Result 4단계: 0.8s 이후 (확인 버튼 페이드 인)
- 고등급 스킵 불가: 최초 0.5s

## 참조 시스템
- (없음)

## 주요 섹션
- 문서 개요
- 핵심 목표
- 일관적인 행동의 패턴을 통한 학습으로 피로도 최소화
- 즉각적 피드백 학습을 통한 조작 신뢰도 향상
- 결과 보고 및 보상등을 통함 성취 몰입도 극대화
- 개발 효율성 및 유지보수의 표준화
- 기능 기본 정의
- UI 전환 통합 규칙
- 전환 방식의 분류
- 타입 별 화면 전환 상세 기획
- Info Flow 전환 프로세스
- Content 전환 프로세스
- Result 전환 프로세스
- System 전환 프로세스
