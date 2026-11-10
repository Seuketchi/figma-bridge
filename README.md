# figma-bridge

Run Figma Plugin API scripts in an open Figma file from any MCP client (such as Claude Code), and get the result back: return values, errors and screenshots. No copying and pasting into a scripting plugin, no size limit, no paid plan, no dependencies.

```text
MCP client ──stdio──▶ server.mjs ──ws://localhost:3055──▶ MCP Bridge plugin in Figma
```

| Tool | Does |
| --- | --- |
| `figma_status` | Whether the plugin is connected; the file, its pages, the selection and the top-level nodes. |
| `figma_run` | Runs JavaScript as the body of an async function with `figma` in scope. Returns the `return` value, `print`/`console.log` lines, or the error. |
| `figma_run_file` | The same, for a script file on disk (large generated scripts stay out of the conversation). |
| `figma_screenshot` | Exports a node as PNG, returns the image and saves it to `shots/`. |

## Needs

- Node 18 or later.
- The Figma desktop app, because development plugins only load there. On Linux, the unofficial [figma-linux](https://github.com/Figma-Linux/figma-linux) app works; see below.
- Any Figma plan, including the free one.

## Set up

1. Clone this repository.
2. Add the server to your MCP client. For Claude Code:
   `claude mcp add -s user figma-bridge -- node /path/to/figma-bridge/server.mjs`
3. In Figma: press Ctrl+/ (Cmd+/ on a Mac), run **Import plugin from manifest** and pick `plugin/manifest.json`.

## Use

Open a file, then run **Plugins > Development > MCP Bridge** and keep its small window open. The dot turns green when the server is connected.

One server holds the port at a time. A second one waits and takes over when the port is free. Set `FIGMA_BRIDGE_PORT` to use another port (and change it in `plugin/manifest.json` and `plugin/ui.html`).

`node scripts/probe.mjs [node-id]` checks the whole path without an MCP client: it waits for the plugin, runs a read-only script and takes a screenshot.

## Security

Whatever the MCP client sends runs in your open Figma file with the full Plugin API, as your account, and can change or delete anything in the file. Use it with a client you trust, and keep version history in mind.

The server listens on 127.0.0.1 only and refuses WebSocket connections from web pages (any `Origin` other than the plugin's `null`). Nothing leaves your computer except what Figma itself sends.

## figma-linux notes

- Logging in goes through your browser and back with a `figma://` link. If the app never logs in, register it as the handler: `update-desktop-database ~/.local/share/applications` and `xdg-mime default figma-linux.desktop x-scheme-handler/figma` (with a `figma-linux.desktop` file whose `Exec` ends in `%U`).
- In version 0.11.5, a second copy of the app does not hand a link to the running one. To open a file, start the app with its URL as an argument.

## Test

`npm test`

## Licence

MIT
