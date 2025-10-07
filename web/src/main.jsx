import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';

// Detect API base (defaults to same host as the dashboard)
const API_BASE =
  import.meta.env.VITE_API_BASE?.trim() ||
  `${window.location.protocol}//${window.location.host}`;

// Expose for quick debugging if needed
window.__MEXC_CFG__ = { API_BASE };

const rootEl = document.getElementById('root');
createRoot(rootEl).render(
  <React.StrictMode>
    <App apiBase={API_BASE} />
  </React.StrictMode>
);
