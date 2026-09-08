import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './ui/app.css';
import { SettingsRoot } from './ui/settings/SettingsRoot';
import { AssetBrowserPanel } from './ui/assets/AssetBrowserPanel';
import { PerfRoot } from './ui/perf/PerfRoot';
import { CritiqueRoot } from './ui/critique/CritiqueRoot';

// `SettingsRoot`, `AssetBrowserPanel`, `PerfRoot`, and `CritiqueRoot` are
// each self-contained panes (their own toggle + overlay) added as siblings
// of `<App />` rather than inside it: their Phase 4 tasks are explicitly
// scoped away from `App.tsx` and every other existing `src/ui/` file, so
// each can run in the same shared working tree as a concurrent, disjoint
// Phase 4 task without either one touching a file the other might also
// need. This is the one line per pane that makes it reachable; each panel
// owns everything else about how it renders.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <SettingsRoot />
    <AssetBrowserPanel />
    <PerfRoot />
    <CritiqueRoot />
  </StrictMode>,
);
