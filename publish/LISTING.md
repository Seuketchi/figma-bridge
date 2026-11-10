# Figma Community listing

Submit from the Figma desktop app: Plugins > Development > Manage plugins in development > MCP Bridge > Publish. Figma reviews it (usually a few days). When Figma gives the plugin its number, put it in `plugin/manifest.json` as `"id"`, commit, and add the Community link to the README.

- **Name:** MCP Bridge
- **Tagline:** Run Plugin API scripts in this file from your MCP client.
- **Icon:** `publish/icon.png` (128 × 128)
- **Cover:** `publish/cover.png` (1920 × 960)
- **Tags:** mcp, automation, developer, scripting, ai
- **Support contact:** https://github.com/Seuketchi/figma-bridge/issues
- **Network access reason:** Connects only to the figma-bridge server running on this computer (ws://localhost:3055).

**Description:**

MCP Bridge connects this file to an MCP client on your computer, such as Claude Code, through the free figma-bridge server (https://github.com/Seuketchi/figma-bridge).

The client can:
- run Plugin API scripts in the open file and get the return value, printed lines or the error back;
- read a frame as design data (layout, colours, type, components, variables and styles) to build it in code;
- take screenshots of any frame.

To use it, start the server with `npx -y github:Seuketchi/figma-bridge` (or add it to your MCP client), open this plugin and keep its window open. The dot turns green when the client is connected.

The plugin talks only to localhost and sends nothing anywhere else. Scripts the client sends can change or delete anything in the open file, so use it with a client you trust.
