const GATE_LABELS = {
  approvals: 'Approvals',
  checks: 'Checks',
  findings: 'Findings',
  up_to_date: 'Up to date'
}
const MONITOR_ORDER = ['confidence', 'risk', 'security', 'drift', 'loose_ends']
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 }

const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
  )
const shortSha = (sha) => (sha ? sha.slice(0, 7) : '')

export function monitorTone(monitor) {
  const lowerIsBetter = monitor.polarity === 'lower_is_better'
  if (monitor.value_type === 'boolean') {
    if (monitor.boolean_value == null) return 'muted'
    return monitor.boolean_value === lowerIsBetter ? 'warn' : 'good'
  }
  if (monitor.percent_value == null) return 'muted'
  const goodness = lowerIsBetter ? 100 - monitor.percent_value : monitor.percent_value
  return goodness >= 80 ? 'good' : goodness >= 50 ? 'warn' : 'bad'
}

function monitorValue(monitor) {
  if (monitor.value_type === 'boolean') {
    return monitor.boolean_value == null ? '—' : monitor.boolean_value ? 'Yes' : 'No'
  }
  return monitor.percent_value == null ? '—' : `${monitor.percent_value}%`
}

function sortMonitors(monitors) {
  const rank = (key) => {
    const index = MONITOR_ORDER.indexOf(key)
    return index === -1 ? MONITOR_ORDER.length : index
  }
  return [...monitors].sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key))
}

function renderScores(monitors, headSha) {
  if (monitors.length === 0) {
    return '<p class="empty">No runner scores yet.</p>'
  }
  const scoredSha = monitors.find((monitor) => monitor.head_sha === headSha)?.head_sha
  const note = scoredSha
    ? ''
    : `<p class="note">Runners haven't scored ${escapeHtml(shortSha(headSha))} yet. Showing the last scores.</p>`
  const rows = sortMonitors(monitors)
    .map((monitor) => {
      const stale = monitor.head_sha !== headSha
      const bar =
        monitor.value_type === 'percent' && monitor.percent_value != null
          ? `<span class="bar"><i style="width:${Math.max(0, Math.min(100, monitor.percent_value))}%"></i></span>`
          : '<span class="bar bar-empty"></span>'
      return `<details class="row ${monitorTone(monitor)}${stale ? ' stale' : ''}">
  <summary><span class="dot"></span><span class="label">${escapeHtml(monitor.label)}</span>${bar}<span class="value">${escapeHtml(monitorValue(monitor))}</span></summary>
  <p class="detail">${escapeHtml(monitor.rationale)}${stale ? ` <span class="sha">(${escapeHtml(shortSha(monitor.head_sha))})</span>` : ''}</p>
</details>`
    })
    .join('\n')
  return `${note}${rows}`
}

function renderGates(gates) {
  if (gates.length === 0) {
    return '<p class="empty">No gates reported.</p>'
  }
  return gates
    .map((gate) => {
      const tone =
        gate.status === 'passed' ? 'good' : gate.status === 'failed' ? 'bad' : 'muted'
      const icon = gate.status === 'passed' ? '✓' : gate.status === 'failed' ? '✕' : '•'
      return `<div class="gate ${tone}"><span class="icon">${icon}</span><span class="label">${escapeHtml(GATE_LABELS[gate.key] ?? gate.key)}</span><span class="detail">${escapeHtml(gate.rationale ?? gate.status)}</span></div>`
    })
    .join('\n')
}

function renderFindings(findings) {
  if (!findings) {
    return '<p class="empty">Findings unavailable.</p>'
  }
  if (findings.items.length === 0) {
    return '<p class="empty">No open findings.</p>'
  }
  return [...findings.items]
    .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3))
    .map((finding) => {
      const location = finding.file
        ? `${finding.file}${finding.line ? `:${finding.line}` : ''}`
        : 'General'
      const summary = finding.title || finding.body.split('\n')[0]
      return `<details class="finding">
  <summary><span class="severity ${escapeHtml(finding.severity)}">${escapeHtml(finding.severity)}</span><span class="location">${escapeHtml(location)}</span></summary>
  <p class="detail">${escapeHtml(summary)}</p>
  ${finding.body && finding.body !== summary ? `<p class="detail body">${escapeHtml(finding.body)}</p>` : ''}
</details>`
    })
    .join('\n')
}

function findingsCount(findings) {
  if (!findings) return ''
  const { Open = 0, OpenHigh = 0, OpenMedium = 0, OpenLow = 0 } = findings.counts ?? {}
  if (Open === 0) return '0 open'
  const parts = [
    OpenHigh && `${OpenHigh} high`,
    OpenMedium && `${OpenMedium} medium`,
    OpenLow && `${OpenLow} low`
  ].filter(Boolean)
  return `${Open} open${parts.length ? ` · ${parts.join(', ')}` : ''}`
}

function renderBody(view) {
  switch (view.status) {
    case 'ready': {
      const { trail } = view
      return `<header>
  <div class="trail-line"><span class="number">Trail #${escapeHtml(trail.number)}</span><span class="status">${escapeHtml(trail.status)}</span></div>
  <div class="title">${escapeHtml(trail.title)}</div>
  <div class="meta">${escapeHtml(view.branch)} · ${escapeHtml(shortSha(trail.headSha))} → ${escapeHtml(trail.base)}</div>
</header>
<section><h2>Scores</h2>${renderScores(view.monitors, trail.headSha)}</section>
<section><h2>Gates</h2>${renderGates(trail.gates)}</section>
<section><h2>Findings <span class="count">${escapeHtml(findingsCount(view.findings))}</span></h2>${renderFindings(view.findings)}</section>`
    }
    case 'no-trail':
      return `<p class="message">No open Entire trail for <code>${escapeHtml(view.branch)}</code>. Trails attach after the first push and detach when the PR merges.</p>`
    case 'error':
      return `<p class="message">Couldn't read the trail for <code>${escapeHtml(view.branch)}</code>.</p><pre class="error">${escapeHtml(view.error)}</pre>`
    default:
      return '<p class="message">Waiting for Entire… If this stays, check that this folder was added under <b>Settings → Plugins → Development</b>. Orca locks installed copies, so the panel can\'t update there.</p>'
  }
}

export function renderPanel(view, updatedAt) {
  const time = updatedAt
    ? `<footer>Updated ${escapeHtml(updatedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}</footer>`
    : ''
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  :root { --good: #3fb950; --warn: #d29922; --bad: var(--destructive, #f85149); }
  body { margin: 0; padding: 12px; overflow-wrap: anywhere; font: 12px/1.45 system-ui, sans-serif; color: var(--foreground, #ddd); background: var(--background, transparent); }
  header { margin-bottom: 14px; }
  .trail-line { display: flex; gap: 8px; align-items: center; }
  .number { font-weight: 600; }
  .status { padding: 0 6px; border: 1px solid var(--border, #444); border-radius: 999px; color: var(--muted-foreground, #999); font-size: 11px; }
  .title { margin-top: 4px; font-size: 13px; }
  .meta, .count, .note, .empty, .detail, footer, .sha { color: var(--muted-foreground, #999); }
  .meta { margin-top: 2px; font-size: 11px; }
  section { margin-bottom: 14px; }
  h2 { margin: 0 0 6px; font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--muted-foreground, #999); }
  .count { text-transform: none; letter-spacing: 0; font-weight: 400; margin-left: 4px; }
  details { border-bottom: 1px solid var(--border, #333); }
  summary { display: flex; align-items: center; gap: 8px; padding: 5px 0; cursor: pointer; list-style: none; }
  summary::-webkit-details-marker { display: none; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--muted-foreground, #999); }
  .good .dot { background: var(--good); }
  .good .icon { color: var(--good); }
  .warn .dot { background: var(--warn); }
  .bad .dot { background: var(--bad); }
  .bad .icon { color: var(--bad); }
  .muted .icon { color: var(--muted-foreground, #999); }
  .label { flex: none; min-width: 72px; }
  .bar { flex: 1; height: 4px; border-radius: 2px; background: var(--muted, #333); overflow: hidden; }
  .bar i { display: block; height: 100%; background: currentColor; }
  .good .bar i { background: var(--good); }
  .warn .bar i { background: var(--warn); }
  .bad .bar i { background: var(--bad); }
  .bar-empty { background: none; }
  .value { flex: none; min-width: 36px; text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
  .stale { opacity: .55; }
  .detail { margin: 0 0 8px; white-space: pre-wrap; }
  .gate { display: grid; grid-template-columns: 14px 72px 1fr; gap: 6px; padding: 4px 0; border-bottom: 1px solid var(--border, #333); }
  .gate .detail { margin: 0; }
  .severity { flex: none; padding: 0 6px; border-radius: 4px; font-size: 10px; font-weight: 600; text-transform: uppercase; background: var(--muted, #333); }
  .severity.high { color: var(--bad); }
  .severity.medium { color: var(--warn); }
  .location { min-width: 0; font-family: ui-monospace, monospace; font-size: 11px; }
  .message { color: var(--muted-foreground, #999); }
  code, pre { font-family: ui-monospace, monospace; font-size: 11px; }
  pre.error { white-space: pre-wrap; color: var(--bad); }
  footer { font-size: 11px; }
</style>
</head>
<body>
${renderBody(view)}
${time}
</body>
</html>
`
}
