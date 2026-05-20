# Security Policy

## Supported versions

stitchkit is pre-1.0. Security fixes land on the latest `0.1.x` release only.

| Version | Supported |
|---------|-----------|
| `0.1.x` | yes       |
| `< 0.1` | no        |

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.**

Report it privately, by either:

- [GitHub private vulnerability reporting](https://github.com/max-listov/stitchkit/security/advisories/new)
  (the **Security** tab → *Report a vulnerability*), or
- email to **maxlistov@gmail.com** with `stitchkit security` in the subject.

Please include:

- the affected version and entrypoint (`stitchkit`, `/server`, `/tools`, `/react`),
- a description of the issue and its impact,
- a minimal reproduction if possible.

## What to expect

- An acknowledgement within **72 hours**.
- An initial assessment within **7 days**.
- Coordinated disclosure: a fix is prepared and released before the issue is
  made public; reporters are credited unless they ask otherwise.

## Scope

stitchkit handles security-relevant surfaces directly — JWT verification, CORS,
auth scopes, multipart limits, SSRF defenses in `mountViewFile`. Issues in any
of these are in scope. Issues in a consuming application's own handlers, or in a
peer dependency (`zod`, `socket.io`, `@modelcontextprotocol/sdk`, …), should be
reported to that project.
