import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { monitorTone, renderPanel, scorePrompt, shellQuote } from '../render.mjs'

const percent = (polarity, percent_value) => ({ value_type: 'percent', polarity, percent_value })

test('monitor tone follows each runner polarity', () => {
  assert.equal(monitorTone(percent('higher_is_better', 85)), 'good')
  assert.equal(monitorTone(percent('higher_is_better', 78)), 'warn')
  assert.equal(monitorTone(percent('lower_is_better', 8)), 'good')
  assert.equal(monitorTone(percent('lower_is_better', 60)), 'bad')
  assert.equal(
    monitorTone({ value_type: 'boolean', polarity: 'lower_is_better', boolean_value: true }),
    'warn'
  )
})

const readyView = (overrides) => ({
  status: 'ready',
  branch: 'feature',
  trail: {
    number: 7,
    title: 'feat: x',
    status: 'open',
    base: 'main',
    headSha: 'bbbbbbb1',
    gates: [],
    checks: []
  },
  monitors: [],
  findings: { counts: { Open: 0 }, items: [] },
  ...overrides
})

test('finding text from reviewers is escaped', () => {
  const html = renderPanel(
    readyView({
      findings: {
        counts: { Open: 1, OpenHigh: 1 },
        items: [{ severity: 'high', title: null, body: '<img src=x onerror=alert(1)>', file: 'a.ts', line: 3 }]
      }
    })
  )
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'))
  assert.ok(!html.includes('<img'))
})

test('scores from an older push are marked stale', () => {
  const html = renderPanel(
    readyView({
      monitors: [{ key: 'risk', label: 'Risk', ...percent('lower_is_better', 10), head_sha: 'aaaaaaa1' }]
    })
  )
  assert.ok(html.includes("Runners haven't scored bbbbbbb yet"))
  assert.ok(html.includes('class="row good stale"'))
})

test('comments survive bash and zsh quoting verbatim', () => {
  const comment = 'it\'s fine\n"quoted" \\ $(rm -rf ~) `whoami` !history\ttab'
  for (const shell of ['bash', 'zsh']) {
    const echoed = execFileSync(shell, ['-c', `printf %s ${shellQuote(comment)}`], { encoding: 'utf8' })
    assert.equal(echoed, comment, shell)
  }
})

test('actions need an open trail and its Entire terminal', () => {
  assert.ok(renderPanel(readyView({ terminalId: 'term_1' })).includes('data-terminal="term_1" data-trail="7"'))
  assert.ok(!renderPanel(readyView({})).includes('id="approve"'))
  const merged = readyView({ terminalId: 'term_1' })
  merged.trail = { ...merged.trail, status: 'merged' }
  assert.ok(!renderPanel(merged).includes('id="approve"'))
})

test('approve is disabled once the approvals gate passes', () => {
  const view = readyView({ terminalId: 'term_1' })
  assert.ok(renderPanel(view).includes('<button id="approve" class="primary">Approve</button>'))
  view.trail = { ...view.trail, gates: [{ key: 'approvals', status: 'passed', rationale: '1 approval(s) recorded' }] }
  assert.ok(renderPanel(view).includes('<button id="approve" class="primary" disabled>Approved</button>'))
})

const looseEnds = {
  key: 'loose_ends',
  label: 'Loose Ends',
  value_type: 'boolean',
  polarity: 'lower_is_better',
  boolean_value: true,
  rationale: '2 loose ends\n• doc never written\n• question unanswered',
  head_sha: 'bbbbbbb1'
}

test('score prompts are one line, capped, and worded for the score', () => {
  const clear = scorePrompt(looseEnds, 7)
  assert.ok(!clear.includes('\n'))
  assert.ok(clear.startsWith("Clear up the loose ends that Entire Trail #7's Loose Ends runner found on bbbbbbb."))
  assert.ok(clear.includes('2 loose ends • doc never written • question unanswered'))
  const risk = { key: 'risk', label: 'Risk', ...percent('lower_is_better', 27), rationale: 'x'.repeat(5000), head_sha: 'bbbbbbb1' }
  const lower = scorePrompt(risk, 7)
  assert.ok(lower.startsWith('Lower the Risk score Entire Trail #7 gave bbbbbbb (now 27%)'))
  assert.ok(lower.length < 4096)
})

test('each agent tab gets its own button on scores that can improve', () => {
  const monitors = [looseEnds, { key: 'risk', label: 'Risk', ...percent('lower_is_better', 0), rationale: 'none', head_sha: 'bbbbbbb1' }]
  const agents = [
    { terminalId: 'term_a', name: 'Claude' },
    { terminalId: 'term_b', name: 'Codex' }
  ]
  const html = renderPanel(readyView({ terminalId: 'term_1', agents, monitors }))
  assert.equal(html.match(/class="ask-row"/g).length, 1)
  assert.ok(html.includes('<span>Clear these up with</span>'))
  assert.ok(html.includes('data-terminal="term_a" data-agent-name="Claude">Claude</button>'))
  assert.ok(html.includes('data-terminal="term_b" data-agent-name="Codex">Codex</button>'))
  assert.ok(!renderPanel(readyView({ terminalId: 'term_1', agents: [], monitors })).includes('class="ask-row"'))
})

test('scores show the change since the previous commit and their history', () => {
  const risk = {
    key: 'risk',
    label: 'Risk',
    ...percent('lower_is_better', 18),
    rationale: 'r',
    head_sha: 'bbbbbbb1',
    history: [
      { sha: 'aaaaaaa1', percent_value: 48, boolean_value: null },
      { sha: 'bbbbbbb1', percent_value: 18, boolean_value: null }
    ]
  }
  const cleared = {
    ...looseEnds,
    boolean_value: false,
    history: [
      { sha: 'aaaaaaa1', percent_value: null, boolean_value: true },
      { sha: 'bbbbbbb1', percent_value: null, boolean_value: false }
    ]
  }
  const html = renderPanel(readyView({ monitors: [risk, cleared] }))
  assert.ok(html.includes('<span class="delta good" title="Change since aaaaaaa">▼30</span>'))
  assert.ok(html.includes('<span class="delta good" title="Change since aaaaaaa">cleared</span>'))
  assert.ok(html.includes('History by commit: <span title="aaaaaaa">48%</span> → <span title="bbbbbbb">18%</span>'))
})

test('the trail number links to the trail when the panel can act', () => {
  const view = readyView({ terminalId: 'term_1' })
  view.trail = { ...view.trail, url: 'https://entire.io/gh/acme/app/trails/7' }
  assert.ok(renderPanel(view).includes('<button id="open-trail" class="number link" data-url="https://entire.io/gh/acme/app/trails/7"'))
  assert.ok(!renderPanel({ ...view, terminalId: null }).includes('id="open-trail"'))
})

test('refresh touches the worker signal file through the Entire terminal', () => {
  const html = renderPanel(readyView({ terminalId: 'term_1', refreshPath: '/Users/x/.cache/orca-entire-trails/refresh' }))
  assert.ok(html.includes('data-refresh-path="/Users/x/.cache/orca-entire-trails/refresh"'))
  assert.ok(html.includes('<button id="refresh"'))
  assert.ok(!renderPanel(readyView({ terminalId: 'term_1' })).includes('<button id="refresh"'))
})

test('failed checks sort first', () => {
  const view = readyView({})
  view.trail = {
    ...view.trail,
    checks: [
      { name: 'b-pass', status: 'completed', conclusion: 'success', app: 'GitHub Actions' },
      { name: 'a-fail', status: 'completed', conclusion: 'failure', app: 'GitHub Actions' },
      { name: 'c-run', status: 'in_progress', conclusion: null, app: 'GitHub Actions' }
    ]
  }
  const html = renderPanel(view)
  assert.ok(html.indexOf('a-fail') < html.indexOf('c-run'))
  assert.ok(html.indexOf('c-run') < html.indexOf('b-pass'))
  assert.ok(html.includes('1 failed · 1 running · 1 passed'))
})
