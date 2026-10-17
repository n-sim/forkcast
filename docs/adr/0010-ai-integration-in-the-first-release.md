---
status: accepted
---

# Include AI integration in the first release

AI integration is a core feature that must shape Forkcast's initial architecture and be functional in the first release, including recipe creation, collection-based cooking planning, nutritional estimation, and supported conversions. ChatGPT subscription access is the initial integration. AI configuration remains optional: a person can use the application without it, with AI-specific features unavailable. Gurkerl MCP integration may follow the first release.

Under [ADR 0015](0015-embed-a-shared-rust-core-and-synchronize.md), installed apps include the native AI runtime in their shared Rust application core. Standalone access needs no separate companion process or household server. Connected AI executes on the server after an explicit in-app setup that completes the documented [local loopback sign-in flow](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) and transfers credentials directly from native runtime to authenticated server over HTTPS. SSH and manual credential copying are no longer the user setup. The transfer preserves the server host identity and establishes one refresh owner, following the [remote setup guidance](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms). Browser users need an installed app for initial setup and reconnection; Android sign-in/lifecycle behavior must be verified on a physical device. Server outages do not trigger an implicit credential fallback.

AI-generated recipes are saved automatically and opened for viewing/editing. AI cooking plans select recipes from the household collection and replace only the selected period, requiring confirmation when existing entries would be affected. Saved editable system-prompt defaults and request-specific instructions guide generation.

AI preferences and prompt defaults belong to the individual and synchronize across that person's devices when a server is configured. Credential sessions remain protected in the selected execution runtime and are transferred only by explicit AI setup, never ordinary data synchronization. Generated recipes are saved through the same workflow as manual recipes; installed apps persist them locally before synchronization into the shared household collection.

Manual food-log entries may use AI estimates from text or an image. The application does not retain an image supplied for food estimation. A separately attached recipe cover photo is retained as part of the shared recipe.
