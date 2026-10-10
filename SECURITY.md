# Security Policy

## Supported versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Reporting a vulnerability

opencode-foresight stores memories locally and makes no network calls, but issues that could lead to data loss, path traversal outside the memory directory, or injection of untrusted content into the system prompt are still security-relevant.

Please report vulnerabilities privately using one of these channels:

- **GitHub Security Advisories**: [Report a vulnerability](https://github.com/dialectstudio/opencode-foresight/security/advisories/new) (preferred)
- **Email**: dialectstudiollc@gmail.com with the subject `[SECURITY] opencode-foresight`

Please include:

- A description of the issue and its impact
- Steps to reproduce (a minimal config + `memories.jsonl` sample helps)
- Affected version

You should receive an acknowledgement within 7 days. We will work with you on a coordinated disclosure and credit reporters who wish to be named.
