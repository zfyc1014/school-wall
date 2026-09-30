import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';

import './styles/tokens.css';
import './styles/global.css';
import './styles/chrome.css';
import './styles/wall.css';
import './styles/sheets.css';
import './styles/beta.css';
import './styles/mobile.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root not found in web/index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
);
