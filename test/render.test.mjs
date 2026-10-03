import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { monitorTone, renderPanel, shellQuote } from '../render.mjs'

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
