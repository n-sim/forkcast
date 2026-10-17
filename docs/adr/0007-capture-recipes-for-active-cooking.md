---
status: accepted
---

# Capture recipe contents when guided cooking starts

An ongoing cooking session uses the ingredients and instructions captured when it started, preserves its step progress when its view is closed, and indicates subsequent recipe changes. This deliberately allows a session to continue with earlier contents while normal recipe views show the current recipe, protecting the cooking flow from edits made during preparation. Step timers are foreground-only initially.

Archiving the source recipe does not cancel an already-started session. The session may finish using its captured contents and displays an archived notice.
