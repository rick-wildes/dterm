# dterm

Persistent terminal sessions for VS Code workspaces, with auto-reattach. Self-contained — no external `tmux` or `screen` required.

## What it does

dterm spawns a small background daemon on first use. The daemon owns the pty for each session you open. When you close a VS Code window and reopen it later — or reload the window, or reconnect over SSH, or upgrade VS Code Server — your terminals come back with the same shells running, the same scrollback, the same working directories, the same labels, and the same editor-area placements.

Unlike VS Code's built-in terminal persistence, dterm sessions survive VS Code Server restarts and version upgrades, because the daemon's lifecycle is independent of VS Code's pty host. (Sessions don't survive dev container rebuilds or host reboots — the daemon lives inside the container or on the host, so anything that wipes that environment wipes the sessions too.)

## Features

- **Persistent shells.** Live processes, working directories, and scrollback all preserved across reloads, restarts, and reconnects.
- **Per-workspace scope.** Sessions are tagged with a hash of the workspace folder path; each workspace has an independent session pool.
- **Multi-client.** Multiple VS Code clients can attach to the same daemon and see the same sessions concurrently (e.g., one window per monitor on the same dev container, or a fresh client reattaching while another is still connected).
- **Editor-area placement preserved.** If you moved a terminal to the editor area, it comes back there on next open. Column and tab-order within a column are remembered, scoped per-client (different laptops connecting to the same remote keep independent layouts, matching VS Code's own per-laptop terminal layout behavior).
- **Custom labels persist.** Right-click → Rename. The label survives reattach (also per-client scoped).
- **Fresh sockets on reattach.** `SSH_AUTH_SOCK`, `VSCODE_GIT_IPC_HANDLE`, and `VSCODE_IPC_HOOK_CLI` are indirected through workspace-scoped symlinks, so reattached terminals always see the *current* VS Code host's sockets, not stale ones from a prior session. This is what keeps `code` CLI (plus the git askpass IPC and SSH agent forwarding) working from a dterm shell after a window reload or SSH reconnect.
- **VS Code shell integration.** dterm terminals are launched via a small stub that VS Code treats as a real shell binary (bash, zsh, or fish), so all of VS Code's automatic shell-integration injection applies: command decorations, command navigation (`Ctrl/Cmd+Up/Down`), recent commands, accurate CWD reporting. Integration persists naturally across reattach — the daemon's shell process keeps running with the scripts already loaded; reattaching just starts a new stub that bridges stdio.
- **Extension-contributed env propagates correctly.** Because the stub is launched by VS Code's normal terminal path, env vars contributed by other extensions (Claude Code's `CLAUDE_CODE_SSE_PORT`, the git extension's `VSCODE_GIT_*`, Python venv activations, etc.) reach the shell automatically — no probe or extra plumbing needed.

## Usage

After installation, run **dterm: New terminal** from the Command Palette. In a multi-root workspace, pick the folder where the new shell should start. With a single folder, that folder is used automatically. You do not need to make dterm your default terminal profile.

You can also open a terminal via the terminal panel's "+" dropdown → **dterm**. For explicit folder selection in multi-root workspaces, use the Command Palette command above. To make dterm your default profile:

```jsonc
"terminal.integrated.defaultProfile.linux": "dterm",
"terminal.integrated.defaultProfile.osx": "dterm"
```

Sessions are managed by the daemon — closing a window doesn't kill them. Auto-reattach on workspace open is enabled by default (`dterm.autoReconnect`).

## Recommended companion setting

For the cleanest startup experience:

```jsonc
"terminal.integrated.hideOnStartup": "whenEmpty"
```

This stops VS Code from spawning an unwanted default shell in the terminal panel before dterm has a chance to reattach. dterm reveals the panel automatically once the first session is reconnected, without stealing focus from your editor.

## Commands

| Command | Description |
| --- | --- |
| `dterm: New terminal` | Create a new persistent terminal without changing the default profile. Prompts for its starting folder in multi-root workspaces. |
| `dterm: Reattach all workspace sessions` | Reconnect VS Code terminals to live daemon sessions for the current workspace. |
| `dterm: Resync active terminal` | Re-render the current terminal — useful if output looks garbled after concurrent clients edited it. |
| `dterm: List sessions` | Show all live sessions across workspaces. |
| `dterm: Show daemon log` | Open the daemon's log file. |
| `dterm: Show diagnostics` | Print configuration, paths, and daemon state. |
| `dterm: Restart daemon` | Graceful shutdown via shutdown control message, then re-push settings (which lazily re-spawns the daemon). Kills all live sessions. |
| `dterm: Stop daemon` | Graceful shutdown without re-spawning. If the daemon doesn't respond to the shutdown message within 4s, escalates to SIGKILL. The daemon comes back lazily on the next dterm operation. |
| `dterm: Push current settings to daemon` | Re-send the current dterm.* settings to the daemon. |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `dterm.autoReconnect` | `true` | On workspace open, recreate VS Code terminals for each live daemon session belonging to this workspace. |
| `dterm.scrollbackLines` | `0` | Daemon-side scrollback retention in lines, replayed on reattach. `0` follows `terminal.integrated.scrollback`. |
| `dterm.shell` | `""` | Override the shell executable. Empty = `$SHELL` or `/bin/bash`. |
| `dterm.shellArgs` | `[]` | Arguments passed to the shell on new sessions. |
| `dterm.tabTitle` | `""` | Tab-title template for dterm terminals. When non-empty, overrides `terminal.integrated.tabs.title` for dterm sessions only. Supports the standard VS Code variables (`${process}`, `${cwd}`, `${cwdFolder}`, `${workspaceFolder}`, `${workspaceFolderName}`, `${sequence}`, `${separator}`) plus `${session}` (the dterm session id) and `${workspace}` (alias for `vscode.workspace.name`, stable across multi-root). Empty = inherit `terminal.integrated.tabs.title`. |
| `dterm.instanceId` | `""` | Namespace for the daemon. Non-empty values give the extension its own daemon, socket, log, and session pool — useful for running a locally-installed/sideloaded build alongside the marketplace one. The Extension Development Host (F5) defaults to `dev`; this setting overrides that. Reload window after changing. |
| `dterm.useSystemdRun` | `"auto"` | Linux daemon spawn strategy: `"auto"` uses `systemd-run --user` only when logind has `KillUserProcesses=yes` (the case where the double-fork's reparent-to-init isn't enough); `"always"` uses systemd-run whenever user-systemd accepts units; `"never"` always uses the legacy double-fork. When systemd-run is selected, dterm prompts to enable lingering (`loginctl enable-linger`) the first time if it isn't already on — required so user-systemd survives SSH disconnect. The systemd-run path puts the daemon under `systemctl --user list-units dterm-daemon` / `journalctl --user -u dterm-daemon`. |

## How it compares

- **vs `terminal.integrated.enablePersistentSessions`**: VS Code's built-in persistence relies on the pty host, which is a child of VS Code Server and dies when the server dies. Only the scrollback can be revived afterward, not the live shell. dterm keeps the live shell.
- **vs `tmux` / `screen`**: no external dependency, integrates with VS Code's native terminal UI (icons, colors, labels, tab placement, link detection). Output isn't multiplexed through a tmux pane, so VS Code's shell integration (cwd detection, command decoration) keeps working.

## Platform support

- **Linux** and **macOS** (x64 and arm64).
- **Windows** is not supported.
- Requires a Unix-like host with `$XDG_RUNTIME_DIR` or `/tmp` available for the daemon socket.

## How sessions are scoped

Each workspace is hashed (SHA-1 over the workspace folder paths or `.code-workspace` file path, sliced to 8 hex chars) to produce a workspace tag. Session names are prefixed with this tag, so different workspaces never see each other's sessions even though they share a single user-level daemon.

## Internals

See [ARCHITECTURE.md](ARCHITECTURE.md) for the process model, daemon protocol, persistence model, and the design decisions behind the trickier parts (managed-socket indirection, tab-to-session mapping, OSC 633 state replay, tab-title template resolution, etc.).

## License

MIT
