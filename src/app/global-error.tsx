'use client';

import { useEffect } from 'react';
import { reportClientError } from '@/lib/logging/report-client-error';

// Last resort: the root layout itself crashed. This file replaces the
// whole document, so it brings its own <html>/<body> and plain styles,
// and cannot use the translation provider.
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    reportClientError(error, { kind: 'global', digest: error.digest });
  }, [error]);

  return (
    <html lang="id">
      <body
        style={{
          fontFamily: 'system-ui, sans-serif',
          display: 'flex',
          minHeight: '100vh',
          alignItems: 'center',
          justifyContent: 'center',
          margin: 0,
          padding: 16,
          textAlign: 'center',
        }}
      >
        <div style={{ maxWidth: 420 }}>
          <h2>Terjadi masalah / Something went wrong</h2>
          <p>Halaman gagal dimuat. Coba lagi. / The page failed to load. Please try again.</p>
          {error.digest ? (
            <p style={{ fontSize: 12, opacity: 0.7 }}>
              Kode / Code: <code>{error.digest}</code>
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => retry()}
            style={{ padding: '8px 16px', cursor: 'pointer' }}
          >
            Coba lagi / Retry
          </button>
        </div>
      </body>
    </html>
  );
}
