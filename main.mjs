import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, watch } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { renderPanel } from './render.mjs'

const PANEL_PATH = fileURLToPath(new URL('./panel.html', import.meta.url))
const POLL_MS = 1_000
const RECHECK_MS = 30_000
const WATCH_RESTART_MS = 5_000
const DISCUSSION_POLL_MS = 60_000
const DISCUSSION_LIMIT = 10
const REFRESH_DEBOUNCE_MS = 1_500
const PUBLISH_DEBOUNCE_MS = 300
const AGENT_REFRESH_DEBOUNCE_MS = 2_000
const HISTORY_LIMIT = 20
// The panel's Refresh button touches this file through the Entire terminal; it has no other way to reach the worker.
const REFRESH_DIR = join(homedir(), '.cache', 'orca-entire-trails')
const REFRESH_FILE = 'refresh'
const TERMINALS_KEY = 'entire-terminals'
const ORCA_APP_CLI = '/Applications/Orca.app/Contents/Resources/bin/orca'
const ORCA_BIN = existsSync(ORCA_APP_CLI) ? ORCA_APP_CLI : 'orca'
// Orca gives plugin workers the app's PATH, which usually lacks the shell additions where entire lives.
const ENV = {
  ...process.env,
  PATH: [`${homedir()}/.local/bin`, '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH]
    .filter(Boolean)
    .join(':')
}

let cleanup = () => {}

function run(file, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { cwd, env: ENV, timeout: 20_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error((stderr || error.message).trim()))
        else resolve(stdout)
      }
    )
  })
}

const runJson = async (file, args, cwd) => JSON.parse(await run(file, args, cwd))

function pickTrail(trail) {
  return {
    number: trail.number,
    title: trail.title,
    url: trail.url,
    status: trail.status,
    base: trail.base,
    headSha: trail.mergeability?.head_sha ?? null,
    gates: (trail.mergeability?.gates ?? []).map((gate) => ({
      key: gate.gate_key,
      status: gate.status,
      rationale: gate.rationale
    })),
    checks: (trail.mergeability?.checks?.runs ?? []).map((run) => ({
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      app: run.app_name
    }))
  }
}

const pickMessage = (message) => ({
  author: message.author,
  createdAt: message.createdAt,
  body: message.body ?? '',
  replies: (message.replies ?? []).map(pickMessage)
})

function pickFindings(result) {
  return {
    counts: result.counts,
    items: result.findings.map((finding) => ({
      severity: finding.severity,
      title: finding.title,
      body: finding.body ?? '',
      file: finding.location?.filePath ?? null,
      line: finding.location?.startLine ?? null
    }))
  }
}

export default function activate(orca) {
  let focus = null
  let state = { status: 'idle' }
  let monitors = new Map()
  let watcher = null
  let generation = 0
  let lastCheck = 0
  let lastKey = null
  let polling = false
  let refreshTimer = null
  let publishTimer = null
  let agentTimer = null
  let forceTimer = null
  let working = false
  let lastDiscussionCheck = 0
  const discussionCache = new Map()

  const log = (error) => orca.log(error instanceof Error ? error.message : String(error))

  async function publish() {
    const view = { ...state, monitors: [...monitors.values()] }
    const key = JSON.stringify(view)
    if (key === lastKey) return
    lastKey = key
    const temp = `${PANEL_PATH}.tmp`
    await writeFile(temp, renderPanel(view, state.status === 'ready' ? new Date() : null))
    await rename(temp, PANEL_PATH)
  }

  function schedulePublish() {
    clearTimeout(publishTimer)
    publishTimer = setTimeout(() => publish().catch(log), PUBLISH_DEBOUNCE_MS)
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => refresh().catch(log), REFRESH_DEBOUNCE_MS)
  }

  function stopWatch() {
    watcher?.kill()
    watcher = null
  }

  function startWatch(trailNumber, cwd, watchGeneration) {
    const child = spawn('entire', ['trail', 'watch', String(trailNumber), '--json'], {
      cwd,
      env: ENV,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    watcher = child
    const release = () => {
      if (watcher === child) watcher = null
    }
    child.on('error', (error) => {
      release()
      log(error)
    })
    child.on('exit', release)
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (watchGeneration !== generation || !line.startsWith('{')) return
      let data
      try {
        data = JSON.parse(line).data
      } catch {
        return
      }
      if (data?.event_type === 'monitor.updated') {
        const { monitor_key: key, ...monitor } = data.payload
        // The replay is chronological, so the last score per commit wins and history stays ordered.
        const history = (monitors.get(key)?.history ?? []).filter(
          (point) => point.sha !== monitor.head_sha
        )
        history.push({
          sha: monitor.head_sha,
          percent_value: monitor.percent_value,
          boolean_value: monitor.boolean_value
        })
        monitors.set(key, {
          key,
          label: monitor.label,
          value_type: monitor.value_type,
          polarity: monitor.polarity,
          percent_value: monitor.percent_value,
          boolean_value: monitor.boolean_value,
          rationale: monitor.rationale,
          head_sha: monitor.head_sha,
          history: history.slice(-HISTORY_LIMIT)
        })
        schedulePublish()
      } else if (data?.event_type) {
        scheduleRefresh()
      }
    })
  }

  // Panel buttons can only type into a terminal, so each worktree gets one Entire tab for them.
  // Shells retitle tabs, so the handle is remembered in plugin storage rather than found by title.
  async function ensureTerminal(cwd) {
    const stored = (await orca.host.call('storage.get', { key: TERMINALS_KEY }))?.value ?? {}
    const known = stored[cwd]
    if (known) {
      const listed = await runJson(ORCA_BIN, ['terminal', 'list', '--worktree', `path:${cwd}`, '--json'])
      if (listed.result.terminals.some((terminal) => terminal.handle === known)) return known
    }
    const created = await runJson(ORCA_BIN, [
      'terminal',
      'create',
      '--worktree',
      `path:${cwd}`,
      '--title',
      'Entire',
      '--json'
    ])
    const handle = created.result.terminal.handle
    await orca.host.call('storage.set', { key: TERMINALS_KEY, value: { ...stored, [cwd]: handle } })
    return handle
  }

  // Every agent tab in tab order, so each button names exactly where its prompt goes.
  async function findAgents(cwd) {
    const listed = await runJson(ORCA_BIN, ['terminal', 'list', '--worktree', `path:${cwd}`, '--json'])
    const seen = {}
    return listed.result.terminals
      .filter((terminal) => terminal.agentIdentity)
      .map((terminal) => {
        const base =
          terminal.agentIdentity.charAt(0).toUpperCase() + terminal.agentIdentity.slice(1)
        seen[base] = (seen[base] ?? 0) + 1
        return { terminalId: terminal.handle, name: seen[base] > 1 ? `${base} ${seen[base]}` : base }
      })
  }

  async function refreshAgents() {
    if (state.status !== 'ready' || state.trail.status !== 'open' || !focus?.cwd) return
    const agentsGeneration = generation
    const agents = await findAgents(focus.cwd)
    if (agentsGeneration !== generation || state.status !== 'ready') return
    state = { ...state, agents }
    await publish()
  }

  function scheduleAgentRefresh() {
    clearTimeout(agentTimer)
    agentTimer = setTimeout(() => refreshAgents().catch(log), AGENT_REFRESH_DEBOUNCE_MS)
  }

  async function refresh() {
    if (!focus?.cwd) return
    const refreshGeneration = generation
    const { branch, cwd } = focus
    lastCheck = Date.now()
    let trail
    try {
      trail = await runJson('entire', ['trail', 'show', '--branch', branch, '--json'], cwd)
    } catch (error) {
      if (refreshGeneration !== generation) return
      stopWatch()
      state = /no trail found/i.test(error.message)
        ? { status: 'no-trail', branch }
        : { status: 'error', branch, error: error.message }
      return publish()
    }
    const findings = await runJson(
      'entire',
      ['trail', 'finding', '--branch', branch, '--json', '-n', '50'],
      cwd
    ).catch((error) => {
      log(error)
      return null
    })
    const discussions = await fetchDiscussions(trail.number, cwd).catch((error) => {
      log(error)
      return null
    })
    if (refreshGeneration !== generation) return
    if (!focus.terminalId && trail.status === 'open') {
      focus.terminalId = await ensureTerminal(cwd).catch((error) => {
        log(error)
        return null
      })
      if (refreshGeneration !== generation) return
    }
    const agents =
      trail.status === 'open'
        ? await findAgents(cwd).catch((error) => {
            log(error)
            return []
          })
        : []
    if (refreshGeneration !== generation) return
    state = {
      status: 'ready',
      branch,
      trail: pickTrail(trail),
      findings: findings && pickFindings(findings),
      discussions,
      terminalId: focus.terminalId,
      agents,
      refreshPath: join(REFRESH_DIR, REFRESH_FILE)
    }
    if (!watcher) startWatch(trail.number, cwd, refreshGeneration)
    await publish()
  }

  // Discussions emit no watch events, so they are listed on refresh and on a slow poll.
  // A thread is only re-read when its last message changes.
  async function fetchDiscussions(trailNumber, cwd) {
    lastDiscussionCheck = Date.now()
    const trailArgs = ['--trail', String(trailNumber), '--json']
    const listed = await runJson('entire', ['trail', 'comment', 'list', ...trailArgs], cwd)
    const items = listed.items
      .filter((item) => item.kind === 'discussion')
      .sort(
        (a, b) =>
          Number(a.resolved) - Number(b.resolved) || b.lastMessageAt.localeCompare(a.lastMessageAt)
      )
      .slice(0, DISCUSSION_LIMIT)
    const discussions = []
    for (const item of items) {
      let cached = discussionCache.get(item.id)
      if (cached?.lastMessageAt !== item.lastMessageAt) {
        const shown = await runJson('entire', ['trail', 'comment', 'show', item.id, ...trailArgs], cwd)
        cached = { lastMessageAt: item.lastMessageAt, messages: shown.messages.map(pickMessage) }
        discussionCache.set(item.id, cached)
      }
      discussions.push({
        title: item.title,
        resolved: item.resolved,
        messageCount: item.messageCount,
        lastMessageAt: item.lastMessageAt,
        messages: cached.messages
      })
    }
    return discussions
  }

  async function refreshDiscussions() {
    if (state.status !== 'ready' || !focus?.cwd) return
    const discussionsGeneration = generation
    const discussions = await fetchDiscussions(state.trail.number, focus.cwd)
    if (discussionsGeneration !== generation || state.status !== 'ready') return
    state = { ...state, discussions }
    await publish()
  }

  function work(task) {
    working = true
    task()
      .catch(log)
      .finally(() => {
        working = false
      })
  }

  async function focusBranch(branch, announce) {
    const focusGeneration = ++generation
    stopWatch()
    monitors = new Map()
    focus = { branch, cwd: null, terminalId: null }
    lastCheck = Date.now()
    if (announce) {
      state = { status: 'loading', branch }
      await publish()
    }
    try {
      const shown = await runJson(ORCA_BIN, [
        'worktree',
        'show',
        '--worktree',
        `branch:${branch}`,
        '--json'
      ])
      if (focusGeneration !== generation) return
      focus.cwd = shown.result.worktree.path
    } catch (error) {
      if (focusGeneration !== generation) return
      state = { status: 'error', branch, error: `Orca couldn't find this worktree: ${error.message}` }
      return publish()
    }
    await refresh()
  }

  async function poll() {
    if (polling) return
    polling = true
    try {
      const context = await orca.host.call('workspace.readContext')
      const branch = context?.branch?.replace(/^refs\/heads\//, '')
      // Keep the last trail when nothing is focused (e.g. settings) instead of blanking the panel.
      if (!branch) return
      // Focus changes start right away; work for the old branch is dropped by its stale generation.
      if (branch !== focus?.branch) {
        focusBranch(branch, true).catch(log)
        return
      }
      if (working) return
      const sinceCheck = Date.now() - lastCheck
      if (!focus.cwd || state.status !== 'ready') {
        if (sinceCheck >= RECHECK_MS) work(() => (focus.cwd ? refresh() : focusBranch(branch, false)))
      } else if (!watcher && sinceCheck >= WATCH_RESTART_MS) {
        work(refresh)
      } else if (Date.now() - lastDiscussionCheck >= DISCUSSION_POLL_MS) {
        work(refreshDiscussions)
      }
    } finally {
      polling = false
    }
  }

  // A full reload: re-read the trail and agents and replay the score stream from the start.
  async function forceRefresh() {
    lastKey = null
    if (!focus?.cwd) return poll()
    generation += 1
    stopWatch()
    monitors = new Map()
    await refresh()
  }

  function scheduleForceRefresh() {
    clearTimeout(forceTimer)
    forceTimer = setTimeout(() => forceRefresh().catch(log), PUBLISH_DEBOUNCE_MS)
  }

  orca.commands.register('refresh', async () => {
    await forceRefresh()
    return { status: state.status }
  })

  let refreshWatcher = null
  try {
    mkdirSync(REFRESH_DIR, { recursive: true })
    refreshWatcher = watch(REFRESH_DIR, (_event, filename) => {
      if (filename === REFRESH_FILE) scheduleForceRefresh()
    })
    refreshWatcher.on('error', log)
  } catch (error) {
    log(error)
  }

  orca.commands.register('open-trail', async () => {
    if (!state.trail?.url) return { opened: false }
    await run('open', [state.trail.url])
    return { opened: true }
  })

  // Subscribing activates the worker. Agent activity in the focused worktree may mean a new agent tab.
  orca.events.on('agent.status.changed', (payload) => {
    if (focus?.cwd && payload?.worktreeId?.endsWith(`::${focus.cwd}`)) scheduleAgentRefresh()
  })
  orca.events.on('worktree.created', () => {})

  const interval = setInterval(() => poll().catch(log), POLL_MS)
  poll().catch(log)

  cleanup = () => {
    clearInterval(interval)
    clearTimeout(refreshTimer)
    clearTimeout(publishTimer)
    clearTimeout(agentTimer)
    clearTimeout(forceTimer)
    refreshWatcher?.close()
    generation += 1
    stopWatch()
  }
  process.once('exit', () => watcher?.kill())
}

export function deactivate() {
  cleanup()
}
