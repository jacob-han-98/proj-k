// Vite define 으로 빌드 시점에 주입되는 전역 상수.
// electron.vite.config.ts 에서 모든 entry(main/preload/renderer)에 동일 값 주입.

declare const __APP_VERSION__: string;
