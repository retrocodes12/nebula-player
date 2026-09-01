# Security Policy

## Supported versions

Only the latest release is supported. Nebula updates in place on every
platform (the web player is always current; Android, Windows and webOS
prompt when a new build ships), so please update before reporting.

## Reporting a vulnerability

Please **do not open a public issue** for anything exploitable.

Use GitHub's private reporting instead: **Security → Report a
vulnerability** on this repository. You'll get a response there, and a
fix ships before anything is disclosed.

Things especially worth reporting:

- Anything that lets one sync group or watch party read another's data
- Escapes of the CORS-rescue proxy's URL restrictions (SSRF)
- Ways to make the relay or sync server act on unauthenticated input

Nebula has no accounts and stores no personal data, but the services
above are shared infrastructure and their isolation matters.
