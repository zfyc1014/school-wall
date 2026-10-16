import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';

import './styles/tokens.css';
import './styles/global.css';
import './styles/app.css';
import './styles/wall.css';
import './styles/sheets.css';
import './styles/me.css';
import './styles/forum.css';
import './styles/social.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);
