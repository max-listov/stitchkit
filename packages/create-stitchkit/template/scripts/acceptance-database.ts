/**
 * The database the local acceptance gate is allowed to write to.
 *
 * `acceptance:local` creates and destroys its own deployment — its own PM2 home,
 * its own ephemeral ports, its own host allowlist. The database was the one
 * thing it still borrowed: it inherited `DATABASE_URL`, and the runtime gates
 * WRITE. The repository example's smoke posts `/api/repository/refresh` twice,
 * which upserts. So a gate a developer is told to run before handing work off
 * wrote rows into whatever `.env` happened to name — including a production
 * database, if that is what the machine was pointed at.
 *
 * Fail-closed on purpose. An acceptance database that is merely *probably*
 * separate is the same defect one edit later, so an unset variable and one that
 * names the deployment's own database are both refused before a role starts,
 * and the refusal carries the line to paste.
 */

/**
 * The database NAME, which is all a refusal may rely on.
 *
 * Comparing `host:port/name` catches the ordinary mistake and misses the ones
 * that matter: `localhost` and `127.0.0.1` are one server, and so are two DNS
 * names pointing at the same PostgreSQL. A guard that reads those as different
 * databases lets this gate migrate and write into the deployment's own.
 *
 * A hostname is not proof of a different server, so it does not take part in
 * the decision. The cost is a false refusal when two genuinely separate servers
 * host a database of the same name — answered by renaming the throwaway one,
 * which the message asks for. That is the trade a fail-closed gate is supposed
 * to make.
 */
function databaseName(url: URL): string {
  return decodeURIComponent(url.pathname.replace(/^\//, '').replace(/\/+$/, ''));
}

function parse(name: string, value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL.`);
  }
}

/** `…/app` → `…/app_acceptance`, so the refusal can name a line worth pasting. */
function suggestionFrom(deploymentUrl: string | undefined): string {
  if (!deploymentUrl) return 'postgresql://USER:PASSWORD@127.0.0.1:5432/acceptance';
  try {
    const url = new URL(deploymentUrl);
    url.pathname = `${url.pathname.replace(/\/$/, '')}_acceptance`;
    return url.toString();
  } catch {
    return 'postgresql://USER:PASSWORD@127.0.0.1:5432/acceptance';
  }
}

/**
 * The acceptance database URL, or a refusal explaining exactly what to add.
 *
 * Takes the environment rather than reading it, so the rule that keeps a gate
 * off the deployment's database is testable without one.
 */
export function resolveAcceptanceDatabase(
  environment: Record<string, string | undefined>,
): string {
  const acceptance = environment.ACCEPTANCE_DATABASE_URL?.trim();
  const deployment = environment.DATABASE_URL?.trim();

  if (!acceptance) {
    throw new Error(
      'ACCEPTANCE_DATABASE_URL is not set, and `bun run acceptance:local` will not write to the ' +
        'database this deployment uses. Add a line naming a throwaway database to `.env`:\n' +
        `  ACCEPTANCE_DATABASE_URL=${suggestionFrom(deployment)}`,
    );
  }

  const acceptanceUrl = parse('ACCEPTANCE_DATABASE_URL', acceptance);
  if (deployment) {
    const deploymentUrl = parse('DATABASE_URL', deployment);
    if (databaseName(acceptanceUrl) === databaseName(deploymentUrl)) {
      throw new Error(
        `ACCEPTANCE_DATABASE_URL uses the database name "${databaseName(acceptanceUrl)}", which is ` +
          'the one DATABASE_URL names. A different host is not proof of a different server — ' +
          '`localhost` and `127.0.0.1` are one, and so are two DNS names for the same ' +
          'PostgreSQL — and this gate applies migrations and writes rows. Give it a name of ' +
          'its own:\n' +
          `  ACCEPTANCE_DATABASE_URL=${suggestionFrom(deployment)}`,
      );
    }
  }

  return acceptanceUrl.toString();
}
