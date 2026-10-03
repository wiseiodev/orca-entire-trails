import assert from 'node:assert/strict'
import { test } from 'node:test'
import { monitorTone, renderPanel } from '../render.mjs'

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
  trail: { number: 7, title: 'feat: x', status: 'open', base: 'main', headSha: 'bbbbbbb1', gates: [] },
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
