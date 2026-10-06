/**
 * Refuses to run the suite without a database (B-1, R25).
 *
 * `npm test` deliberately runs with no Postgres and skips a third of its
 * assertions. That is a supported way to run and is not being changed. This is
 * the other configuration — the one a release gate should use — and it fails
 * before vitest starts rather than passing with the evidence absent.
 *
 * Not a CI workflow file: adding repository CI was never in this plan's scope.
 * This is the script such a workflow would call.
 */
const url = process.env.TEST_DATABASE_URL;

if (url === undefined || url.trim() === "") {
  process.stderr.write(
    "\n  npm run test:ci requires TEST_DATABASE_URL.\n\n" +
      "  Without it, the database-gated test files skip their assertions — the frozen\n" +
      "  response bodies, the jsonb boundary, the reducer's upsert and the session\n" +
      "  handshake among them — and a run that proves a third less than it appears to\n" +
      "  is exactly what this script exists to prevent.\n\n" +
      "    docker compose -f compose.dev.yml up -d\n" +
      "    TEST_DATABASE_URL=postgres://vorq:vorq@localhost:5433/vorq npm run test:ci\n\n",
  );
  process.exit(1);
}
