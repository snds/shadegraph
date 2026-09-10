import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './ui/app.css';

// Settings, the asset browser, the project manifest, reference critique, and
// (now) the performance budget panel used to each be a self-contained sibling
// pane here (their own fixed-position toggle + overlay). They're now absorbed
// into the shell — Settings/assets/manifest/critique into the pivot rail /
// bottom dock (`src/ui/shell/`, mounted from inside `<App />`; see
// `pivotItems.tsx` and `SettingsDock.tsx`), and the performance budget panel
// into `DocToolbar`'s top-toolbar action group (see `ui/perf/PerfRoot.tsx`).
// Nothing is mounted from here anymore beyond `<App />` itself.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
