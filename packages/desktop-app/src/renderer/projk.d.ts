// Ambient declaration so the renderer sees the preload-exposed `window.projk`.
import type { ProjkApi } from '../preload';

declare global {
  interface Window {
    projk: ProjkApi;
  }
}

export {};
