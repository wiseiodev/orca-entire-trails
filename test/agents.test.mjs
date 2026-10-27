import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pickAgents, reviewRuns, runReviewId } from '../agents.mjs'
import { renderPanel } from '../render.mjs'

const HEAD = 'bbbbbbb1'
const REVIEW_ID = '01M5ZH763RQ77FAYTRMYEHDZYY'
const REVIEW_RUN = '01M5ZH4G93BQH1M8YCY0VYGZCF'

const entry = (id, name, signal, history, run = { status: 'succeeded', head_sha: HEAD, error: null }) => ({
  agent: { id, name },
  signal,
  reading: { ...history[0], rationale: `${name} notes.` },
  latest_run: run,
  history
})

// The change detail lists its agents with their latest reading, history newest first, and latest run.
const TRAIL = {
  agents: [
    entry('01M5Z6HBWARVRNZ0Q8THQRVXTC', 'Drift', { value_type: 'size', polarity: 'lower_is_better' }, [
      { size_value: 'medium', head_sha: HEAD, run_id: '01M5ZGNFM0K48M107YD136JS5Y', updated_at: '2026-10-27T20:29:01.000Z' },
      { size_value: 'small', head_sha: 'aaaaaaa1', run_id: '01M5ZAW4N9XG06S23GHNWNY2RQ', updated_at: '2026-10-27T18:48:00.000Z' }
    ]),
    entry('01M5Z6HCJPZB30PD9WYPY1T444', 'Bug Review', { value_type: 'boolean', polarity: 'lower_is_better' }, [
      { boolean_value: true, head_sha: HEAD, run_id: REVIEW_RUN, updated_at: '2026-10-27T20:35:53.072Z' }
    ]),
    entry(
      '01M5Z6HEYN5CRWTH2CRQ052HWN',
      'Security',
      { value_type: 'percent', polarity: 'lower_is_better' },
      [{ percent_value: 5, head_sha: 'aaaaaaa1', run_id: '01M5ZAW4N9XG06S23GHNWNY2RR', updated_at: '2026-10-27T18:46:00.000Z' }],
      { status: 'failed', head_sha: HEAD, error: 'agent timed out' }
    )
  ]
}

test("a review's agent is the one whose run posted it", () => {
  const [nearest] = reviewRuns(TRAIL, REVIEW_ID)
  assert.deepEqual(nearest, { runId: REVIEW_RUN, agent: 'Bug Review' })
  assert.equal(runReviewId({ review_changes_result: { review_id: REVIEW_ID } }), REVIEW_ID)
  assert.deepEqual(reviewRuns(TRAIL, 'not-a-review'), [])
})

test('agents show as scores, with size scores, failed runs, and the findings they raised', () => {
  const html = renderPanel({
    status: 'ready',
    branch: 'feature',
    trail: { number: 7, selector: 'app/7', title: 'feat: x', status: 'open', base: 'main', headSha: HEAD, gates: [], checks: [] },
    monitors: [],
    agentScores: pickAgents(TRAIL),
    findings: {
      counts: { Open: 1, OpenMedium: 1 },
      items: [{ severity: 'medium', title: null, body: 'A timeout skips the gate.', file: 'src/gate.ts', line: 54, author: 'Bug Review' }]
    }
  })
  const row = (label) => html.split('<details').find((part) => part.includes(`>${label}<`)) ?? ''
  assert.match(row('Drift'), />▲<.*>Medium</)
  assert.match(row('Security'), />failed<.*>5%</)
  assert.match(row('Security'), /agent timed out/)
  assert.match(row('A timeout skips the gate.'), /src\/gate\.ts:54.*Bug Review/)
  assert.match(row('Bug Review'), /raised 1 of the open findings/)
  assert.doesNotMatch(row('Drift'), /raised/)
})
