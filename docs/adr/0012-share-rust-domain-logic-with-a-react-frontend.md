---
status: superseded by ADR-0015
---

# Share Rust domain logic with a React frontend

Superseded by [ADR 0015](0015-embed-a-shared-rust-core-and-synchronize.md). React remains the frontend, but application workflows and SQLite persistence now belong to one shared Rust core embedded in installed apps and hosted on the server. The text below records the previous architecture. Near-instant interactions and desktop keyboard support remain product requirements; startup below 500 ms remains an aspiration.

Use Rust for the self-hosted backend and shared calculation and validation logic, compiled to WebAssembly for the browser. Use React and TypeScript for the web interface, with SQLite for backend persistence. Sharing the domain logic keeps portion scaling, nutritional calculations, and validation consistent between standalone and synchronized use, while retaining the browser UI ecosystem.

The frontend keeps its data locally and supports core workflows without the backend. The optional native AI companion supplies the runtime needed for standalone subscription integration; it does not replace the frontend's local data store.

Prioritize near-instant local interactions and support keyboard shortcuts on desktop. Application startup below 500 ms is an aspiration rather than a release gate or a claim requiring a dedicated performance benchmark; the technology choice alone does not guarantee it.
