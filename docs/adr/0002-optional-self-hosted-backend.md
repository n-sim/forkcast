---
status: superseded by ADR-0015
---

# Make the self-hosted backend optional

Superseded by [ADR 0015](0015-embed-a-shared-rust-core-and-synchronize.md). Installed apps retain server-free use through an embedded Rust core; browser use now requires a household server. The text below records the previous architecture.

Forkcast must support its core workflows through the frontend without requiring a configured backend. A self-hosted backend is an optional addition for backups and synchronization, while AI connectivity and food lookup may still require internet access. This prioritizes use without server setup over relying on a central application service; integration details must preserve that boundary.

Without a backend, a person uses one device for their data. Using the same data across devices, such as planning on a computer and cooking on a tablet, requires opting into the self-hosted synchronization backend.

Initially, each backend instance serves one household. Backups require a backend; standalone mode does not provide a backup export or restore feature. The optional backend may also execute an integration when that integration cannot be supported by the frontend alone, keeping this additional responsibility conditional on actual need.

Standalone ChatGPT subscription access uses an optional local AI companion, separate from synchronization and backups. With a backend configured, AI requests run through that backend after authentication setup. Installing the companion does not enable cross-device synchronization or require creating a backend account.
