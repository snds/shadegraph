// ShadeGraph — the one place a refused action becomes visible.
// Fed by `src/ui/notice.ts`, which mirrors every editor-store rejection.

import { useEffect } from 'react';

import { useNotice } from './notice';

const DISMISS_MS = 5000;

export function NoticeToast() {
  const message = useNotice((s) => s.message);
  const seq = useNotice((s) => s.seq);
  const dismiss = useNotice((s) => s.dismiss);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(dismiss, DISMISS_MS);
    return () => clearTimeout(timer);
    // `seq` restarts the timer when the same message repeats.
  }, [message, seq, dismiss]);

  if (!message) return null;

  return (
    <div className="sg-toast" role="status" aria-live="polite">
      <span className="sg-toast__mark" aria-hidden="true">
        !
      </span>
      <span className="sg-toast__text">{message}</span>
      <button type="button" className="sg-toast__close" onClick={dismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
