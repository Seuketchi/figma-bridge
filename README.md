# figma-bridge

Run Figma Plugin API scripts in an open Figma file from any MCP client (such as Claude Code), and get the result back: return values, errors, design data and screenshots. No copying and pasting into a scripting plugin, no size limit, no paid plan, no dependencies.

```text
MCP client ──stdio──▶ server.mjs ──ws://localhost:3055──▶ MCP Bridge plugin in Figma
```

| Tool | Does |
| --- | --- |
| `figma_status` | Whether the plugin is connected; the file, its pages, the selection and the top-level nodes. |
| `figma_run` | Runs JavaScript as the body of an async function with `figma` in scope. Returns the `return` value, `print`/`console.log` lines, or the error. |
| `figma_run_file` | The same, for a script file on disk (large generated scripts stay out of the conversation). |
| `figma_read` | Reads a frame as design data for building it in code: layout and auto layout, fills, strokes, radius, effects, text styles, components and variant props, and variables and styles by name, plus a summary of what it uses. Optionally with a screenshot. |
| `figma_comments` | Reads the file's comments as threads: author, time, text, resolved or not, the node each is pinned to (named, when the plugin is open on that file) and replies. Filters: `unresolved`, `node_id`. |
| `figma_screenshot` | Exports a node as PNG, returns the image and saves it to `shots/`. |

## Install

**1. The server.** Node 18 or later. Nothing to clone. For Claude Code:

```sh
claude mcp add -s user figma-bridge -- npx -y --allow-git=all github:Seuketchi/figma-bridge
```

For another MCP client, the command is `npx` with the arguments `-y --allow-git=all github:Seuketchi/figma-bridge` (npm 12 refuses GitHub packages without `--allow-git=all`).

**2. The plugin.** Once it is on Figma Community, open its page and click **Open in…**; it then works in the browser and the desktop app, on any plan. Until then:

1. Download `figma-bridge-plugin.zip` from the [latest release](https://github.com/Seuketchi/figma-bridge/releases/latest) and unzip it.
2. In the Figma desktop app, press Ctrl+/ (Cmd+/ on a Mac), run **Import plugin from manifest** and pick `manifest.json` from that folder. Development plugins only load in the desktop app; on Linux the unofficial [figma-linux](https://github.com/Figma-Linux/figma-linux) app works (see below).

## Use

Open a file, then run **Plugins > Development > MCP Bridge** and keep its small window open. The dot turns green when the server is connected.

One server holds the port at a time. A second one waits and takes over when the port is free. Set `FIGMA_BRIDGE_PORT` to use another port (and change it in `plugin/manifest.json` and `plugin/ui.html`).

### Comments

The Plugin API cannot see comments, so `figma_comments` reads them from Figma's REST API. It needs a personal access token with the `file_comments:read` scope (Figma > Settings > Security > Personal access tokens). Save it to `~/.config/figma-bridge/token` or set `FIGMA_TOKEN`. With no `file_key`, it uses the file open in the plugin (the development plugin reports its key; reload the plugin after updating).

`node scripts/probe.mjs [node-id]` checks the whole path without an MCP client: it waits for the plugin, runs a read-only script and takes a screenshot.

## Security

Whatever the MCP client sends runs in your open Figma file with the full Plugin API, as your account, and can change or delete anything in the file. Use it with a client you trust, and keep version history in mind.

The server listens on 127.0.0.1 only and refuses WebSocket connections from web pages (any `Origin` other than the plugin's `null`). Nothing leaves your computer except what Figma itself sends, and, for `figma_comments`, a request to `api.figma.com` with your token. The token stays in the file or variable you put it in.

## figma-linux notes

- Logging in goes through your browser and back with a `figma://` link. If the app never logs in, register it as the handler: `update-desktop-database ~/.local/share/applications` and `xdg-mime default figma-linux.desktop x-scheme-handler/figma` (with a `figma-linux.desktop` file whose `Exec` ends in `%U`).
- In version 0.11.5, a second copy of the app does not hand a link to the running one. To open a file, start the app with its URL as an argument.

## Test

`npm test`

## Licence

MIT
