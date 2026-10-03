# Entire Trails for Orca

An Orca side panel that shows the [Entire](https://entire.io) Trail for the focused worktree:
runner scores (Confidence, Risk, Security, Drift, Loose Ends), gates, and open findings.

It runs the `entire` CLI you already have. Scores update live from `entire trail watch`.

## Requirements

- Orca 1.4.219 or later, with **Settings → Plugins → Plugin system** turned on.
- `entire` installed and signed in (`entire auth status`). The worker looks in
  `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, then Orca's `PATH`.

## Install

Clone the repo, then in Orca open **Settings → Plugins**, add the clone folder as a
development plugin, and approve it.

```sh
git clone https://github.com/wiseiodev/orca-entire-trails.git
cd orca-entire-trails
git update-index --skip-worktree panel.html
```

The last command keeps `git status` clean. The worker rewrites `panel.html` on every update.

Open the panel from the gauge icon in the right sidebar. Two commands are in the command palette:

- **Entire Trails: Refresh**
- **Entire Trails: Open Trail in Browser**

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
