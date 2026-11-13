import type { Instrumentation } from 'next';

// Called by Next.js for every error it catches on the server: route
// handlers, server components, server actions. The error is written to
// the error log (Settings → Error log) as well as the console.
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  // The edge runtime has no node:crypto; the log writer needs it.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { logError } = await import('@/lib/logging/error-log');
  const digest =
    typeof err === 'object' && err !== null && 'digest' in err
      ? String((err as { digest: unknown }).digest)
      : undefined;
  await logError('server', err, {
    context: {
      // Path without the query string: queries can carry tokens.
      path: request.path.split('?')[0],
      method: request.method,
      route: context.routePath,
      routeType: context.routeType,
      digest,
    },
  });
};
