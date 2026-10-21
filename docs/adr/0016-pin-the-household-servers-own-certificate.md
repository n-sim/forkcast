---
status: accepted
---

# Pin the household server's own certificate

Installed apps keep requiring HTTPS for household servers that are not on the same machine: passwords, session tokens, and members' ChatGPT sessions travel over that connection (ADR 0015). Many households run the server on their own network without a domain name, where a reverse proxy with a publicly trusted certificate is not available, and installed apps check certificates only against the public certificate authorities they ship with.

The household server can therefore serve HTTPS itself with its own self-signed certificate (`FORKCAST_TLS=self-signed`), created once beside its database and printed with its SHA-256 fingerprint when it starts. When an installed app reaches a server whose certificate is not publicly trusted, it stores and sends nothing and shows the presented fingerprint; the person compares it with the one the server printed and confirms. The app then pins that exact certificate for that server and accepts no other, ignoring names and validity dates, which the fingerprint makes redundant. The pin is stored with the household link and used for joining, synchronization, account administration, and the ChatGPT handoff. A server presenting a different certificate is refused before any request is sent, and pending changes stay on the device.

Plain HTTP on the local network remains refused, and certificate authorities installed on the device are not consulted. A replaced server certificate is accepted only after the person checks it from Settings and confirms its new fingerprint the same way; the household link, accounts, and pending changes are kept.
