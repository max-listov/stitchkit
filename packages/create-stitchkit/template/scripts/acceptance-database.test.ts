import { describe, expect, test } from 'bun:test';
import { resolveAcceptanceDatabase } from './acceptance-database';

const deployment = 'postgresql://app:secret@127.0.0.1:5432/starter';

describe('the acceptance gate writes only to a database of its own', () => {
  test('a distinct database is accepted', () => {
    expect(
      resolveAcceptanceDatabase({
        DATABASE_URL: deployment,
        ACCEPTANCE_DATABASE_URL: 'postgresql://app:secret@127.0.0.1:5432/starter_acceptance',
      }),
    ).toBe('postgresql://app:secret@127.0.0.1:5432/starter_acceptance');
  });

  test('an unset variable is refused with the line to paste', () => {
    // The gate used to inherit DATABASE_URL. Defaulting to it is exactly the
    // behaviour this replaces, so absence has to be a refusal, not a fallback.
    expect(() => resolveAcceptanceDatabase({ DATABASE_URL: deployment })).toThrow(
      /ACCEPTANCE_DATABASE_URL=postgresql:\/\/app:secret@127\.0\.0\.1:5432\/starter_acceptance/,
    );
  });

  test('the same database written differently is still the same database', () => {
    // Credentials and the scheme do not make it another database; host, port
    // and name do. A check on the raw string would pass this and then migrate
    // the deployment.
    expect(() =>
      resolveAcceptanceDatabase({
        DATABASE_URL: deployment,
        ACCEPTANCE_DATABASE_URL: 'postgres://someone:else@127.0.0.1/starter',
      }),
    ).toThrow(/which is the one DATABASE_URL names/);
  });

  test('a default port on one side and 5432 on the other is one database', () => {
    expect(() =>
      resolveAcceptanceDatabase({
        DATABASE_URL: 'postgresql://app@db.internal/starter',
        ACCEPTANCE_DATABASE_URL: 'postgresql://app@db.internal:5432/starter',
      }),
    ).toThrow(/which is the one DATABASE_URL names/);
  });

  test('the same name on another hostname is refused, because a hostname proves nothing', () => {
    // `localhost` and `127.0.0.1` are one server; so are two DNS names for the
    // same PostgreSQL. A guard that compared `host:port/name` called these two
    // different databases and let the gate migrate the deployment's own.
    expect(() =>
      resolveAcceptanceDatabase({
        DATABASE_URL: 'postgresql://app@localhost:5432/starter',
        ACCEPTANCE_DATABASE_URL: 'postgresql://app@127.0.0.1:5432/starter',
      }),
    ).toThrow(/A different host is not proof of a different server/);
  });

  test('a different name on the same host is fine — the name is what decides', () => {
    // The control. Without it the rule "refuse everything" would pass the case
    // above, and no acceptance database would ever be accepted.
    expect(
      resolveAcceptanceDatabase({
        DATABASE_URL: 'postgresql://app@localhost:5432/starter',
        ACCEPTANCE_DATABASE_URL: 'postgresql://app@localhost:5432/starter_acceptance',
      }),
    ).toContain('starter_acceptance');
  });

  test('a value that is not a URL is named, not silently used', () => {
    expect(() =>
      resolveAcceptanceDatabase({ ACCEPTANCE_DATABASE_URL: 'starter_acceptance' }),
    ).toThrow(/ACCEPTANCE_DATABASE_URL is not a valid URL/);
  });
});
