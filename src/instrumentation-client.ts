import { reportClientError } from '@/lib/logging/report-client-error';

// Errors that no React error boundary sees: event handlers, timers,
// promises nobody awaited. Reported to Settings → Error log.
window.addEventListener('error', (event) => {
  reportClientError(event.error ?? event.message, { kind: 'window' });
});

window.addEventListener('unhandledrejection', (event) => {
  reportClientError(event.reason, { kind: 'promise' });
});
