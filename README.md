# Entire Trails for Orca

An Orca side panel that shows the [Entire](https://entire.io) Trail for the focused worktree:
runner scores (Confidence, Risk, Security, Drift, Loose Ends), gates, CI checks, and open
findings. On an open trail you can approve it or start a discussion from the panel.

It runs the `entire` CLI you already have. Scores update live from `entire trail watch`.

## Requirements

- Orca 1.4.219 or later, with **Settings → Plugins → Plugin system** turned on.
- `entire` installed and signed in (`entire auth status`). The worker looks in
  `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, then Orca's `PATH`.

## Install

Clone the repo, then in Orca open **Settings → Plugins → Development**, add the clone folder,
and approve it. Don't install it from a local path: Orca copies and hash-locks installed plugins,
so the panel can never update.

```sh
git clone https://github.com/wiseiodev/orca-entire-trails.git
cd orca-entire-trails
git update-index --skip-worktree panel.html
```

The last command keeps `git status` clean. The worker rewrites `panel.html` on every update.

Open the panel from the gauge icon in the right sidebar. Two commands are in the command palette:

- **Entire Trails: Refresh**
- **Entire Trails: Open Trail in Browser**

## Approve and comment

Panels can't run commands, only type into a terminal. So for each worktree with an open trail,
the worker opens one terminal tab and remembers it in plugin storage. **Approve** (click twice)
runs `entire trail approve <n>` there, and **Post comment** runs
`entire trail comment add --trail <n> -m $'…'` with the text ANSI-C quoted, so you see each
command and its result. If you close that tab, the worker opens a new one on its next refresh.

A comment you're typing is lost if the panel refreshes, which happens when the trail changes.
CI and score updates are bursty right after a push, so write longer comments once those settle.

## How it works

Orca's plugin API (`pluginApi: 1`) gives panels no way to receive data from their worker
([stablyai/orca#15638](https://github.com/stablyai/orca/issues/15638)). This plugin works around
that by having the worker rewrite `panel.html` whenever the trail changes, and Orca reloads
development plugin panels when their files change.

That has consequences:

- It only works as a **development plugin**. Orca hash-checks plugins installed from git or a
  marketplace, so a rewritten panel fails verification there.
- The panel resets its scroll position and open rows on each update.
- The worker runs `entire` as a child process. Orca has no exec capability yet
  ([stablyai/orca#18214](https://github.com/stablyai/orca/issues/18214)); if one is added, the
  manifest will need to declare it.

The worker starts on the first agent status change or worktree creation, or when you run
**Entire Trails: Refresh**. It reads the focused worktree every 5 seconds, finds its folder with
`orca worktree show`, and reads the trail with `entire trail show`, `entire trail finding`, and
`entire trail watch`.

Trails attach to a branch after its first push and detach when the PR merges, so the panel only
shows open trails.

Score colors are this plugin's thresholds, not Entire's: green at 80 or better (after flipping
"lower is better" scores), amber from 50, red below.

## Develop

```sh
npm test
```
