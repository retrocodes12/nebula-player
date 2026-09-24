# Security Policy

## Supported versions

Only the latest release is supported. Nebula updates in place on every
platform (the web player is always current; Android, Windows, Linux and
webOS prompt when a new build ships), so please update before reporting.

## Reporting a vulnerability

Please **do not open a public issue** for anything exploitable.

Use GitHub's private reporting instead: **Security → Report a
vulnerability** on this repository. You'll get a response there, and a
fix ships before anything is disclosed.

Things especially worth reporting:

- Anything that signs one person in as another: profiles, device tokens,
  TV sign-in codes, recovery keys
- Anything that lets one profile, sync group or watch party read or change
  another's data
- Script from an add-on, a friend's profile or a watch party running in
  the player
- Ways into the desktop app's local services (its loopback server, the
  share-with-your-TV relay) from a web page or another device
- Escapes of the CORS-rescue proxy's URL restrictions (SSRF)
- Ways to make the relay or sync server act on unauthenticated input

A Nebula profile is a handle and a password — no email, no real name.
Passwords, recovery keys, device tokens and sync secrets are stored on the
server only as hashes. The services are shared infrastructure and their
isolation matters.
