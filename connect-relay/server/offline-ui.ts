/**
 * The `ui://olympus/dashboard` HTML the relay serves while an install's Mac is
 * offline. Placeholder: the dashboard lane replaces this module with the same
 * bundle the engine serves (docs/design/chatgpt-plugin.md, "Offline
 * fallback"). Keep the export name and type stable.
 */
export const OFFLINE_DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Olympus</title></head>
<body style="font: 15px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 16px;">
<h1 style="font-size: 1.2rem;">Olympus</h1>
<p>Your Mac is offline. Olympus answers again as soon as your Mac is awake and online.</p>
</body>
</html>
`;
