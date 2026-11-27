import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import 'tachyons/css/tachyons.min.css'
import { registerSW } from 'virtual:pwa-register'

// Register the Service Worker
const updateSW = registerSW({
  onNeedRefresh() {
    // Optional: Show a prompt to the user to refresh the page when an update is available
    if (confirm("New content available. Reload?")) {
      updateSW(true);
    }
  },
  onOfflineReady() {
    console.log("App is ready to work offline!");
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)