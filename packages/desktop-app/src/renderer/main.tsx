import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
// VS Code codicons 폰트 + .codicon-* 클래스. styles.css 보다 먼저 import 해야
// styles.css 안의 .activity-bar-item .codicon 셀렉터가 폰트 정의 이후 적용됨.
import '@vscode/codicons/dist/codicon.css';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('root element missing');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
