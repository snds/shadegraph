import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './ui/app.css';
import { PerfRoot } from './ui/perf/PerfRoot';

// Settings, the asset browser, the project manifest, and reference critique
// used to each be a self-contained sibling pane here (their own fixed-position
// toggle + overlay). They're now absorbed into the shell's pivot rail /
// bottom dock (`src/ui/shell/`, mounted from inside `<App />`) — see
// `pivotItems.tsx` and `SettingsDock.tsx`.
//
// `PerfRoot` stays exactly as it was: the performance budget panel is
// explicitly out of scope for the pivot rail (it becomes a top-panel control
// in a separate task), so it keeps the same self-contained toggle+overlay
// pattern as a sibling of `<App />`.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <PerfRoot />
  </StrictMode>,
);
