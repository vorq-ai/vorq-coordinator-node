import * as Sentry from "@sentry/node";

/**
 * Sentry, preloaded with `node --import` so its hooks are in place before
 * Fastify and pino load — an ESM graph is linked before `main.ts` runs a line,
 * so an init there would instrument nothing.
 *
 * On when `SENTRY_DSN` is set and a no-op otherwise; `SENTRY_ENVIRONMENT` and
 * `SENTRY_RELEASE` are read from the environment too. Every `error`-level log
 * line becomes an event, which covers the unhandled-route handler and every
 * background worker alike, since each of them reports through `app.log`; no
 * line is shipped as a Sentry log. No trace headers go out: the RPC and the
 * object store are someone else's APIs.
 *
 * The Fastify hook reports nothing itself. It fires on every throw, before the
 * error handler has set a status, so a refused request — a 400, a 401, a 503
 * while the index catches up — reads to it as a crash. The handler's own
 * `error` line is the one report of a real fault.
 */
Sentry.init({
  tracePropagationTargets: [],
  integrations: [
    Sentry.pinoIntegration({ error: { levels: ["error", "fatal"] }, log: { levels: [] } }),
    Sentry.fastifyIntegration({ shouldHandleError: () => false }),
  ],
});
