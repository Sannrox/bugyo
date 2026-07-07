# Security Policy

## Supported versions

Bugyo is in early development. Security fixes are applied to the `main` branch
only until a stable release line exists.

| Version | Supported |
| ------- | --------- |
| `main`  | ✅        |
| < 0.1   | ❌        |

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability):

1. Go to the [**Security** tab](https://github.com/Sannrox/bugyo/security) of the
   repository.
2. Click **Report a vulnerability**.
3. Provide a description, reproduction steps, affected versions, and impact.

We aim to acknowledge reports within **72 hours** and to provide a remediation
timeline after triage. Please give us a reasonable window to release a fix
before any public disclosure.

## Scope

Bugyo drives real coding agents that can mutate git repositories, the
filesystem, and approve tool calls. Findings of particular interest include:

- Bypasses of the human-in-the-loop approval model.
- Command or path injection in the subprocess/git layer.
- Escapes from worktree isolation.
- Exfiltration of repository contents, secrets, or user data to third parties.
- Privilege escalation via the Tauri IPC boundary or capability configuration.

## Out of scope

- Vulnerabilities in `kiro-cli` itself (report those to its maintainers).
- Issues requiring a already-compromised local machine or physical access.
- Denial of service caused solely by running an unbounded number of local agents.
