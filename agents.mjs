const HISTORY_LIMIT = 20
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
// A review is created as its run finishes, so its run is the one whose score landed nearest to it.
const REVIEW_MATCH_MS = 60_000
const REVIEW_CANDIDATES = 3

const point = (raw) => ({
  sha: raw?.head_sha ?? '',
  percent_value: raw?.percent_value ?? null,
  boolean_value: raw?.boolean_value ?? null,
  size_value: raw?.size_value ?? null
})

/** The change's agents on Entire as score rows, from the change detail, which lists each history newest first. */
export function pickAgents(trail) {
  return (trail.agents ?? []).map((entry) => {
    const { sha, ...reading } = point(entry.reading)
    return {
      ...reading,
      key: entry.agent.id,
      agentId: entry.agent.id,
      label: entry.agent.name ?? entry.agent.id,
      value_type: entry.signal?.value_type ?? 'percent',
      polarity: entry.signal?.polarity ?? 'higher_is_better',
      rationale: entry.reading?.rationale ?? '',
      head_sha: sha,
      history: [...(entry.history ?? [])].reverse().map(point).slice(-HISTORY_LIMIT),
      run: entry.latest_run
        ? {
            status: entry.latest_run.status,
            sha: entry.latest_run.head_sha ?? '',
            error: entry.latest_run.error ?? null
          }
        : null
    }
  })
}

/** The millisecond time a ULID was made at, or null for anything that isn't one. */
export function ulidTime(id) {
  if (!ULID.test(String(id))) return null
  let time = 0
  for (const char of id.slice(0, 10)) time = time * 32 + CROCKFORD.indexOf(char)
  return time
}

/** The runs most likely to have made the review, nearest first: each agent's scored runs, by when their score landed. */
export function reviewRuns(trail, reviewId) {
  const at = ulidTime(reviewId)
  if (at === null) return []
  return (trail.agents ?? [])
    .flatMap((entry) =>
      (entry.history ?? []).map((one) => ({
        runId: String(one.run_id ?? ''),
        agent: String(entry.agent.name ?? entry.agent.id),
        distance: Math.abs(Date.parse(one.updated_at) - at)
      }))
    )
    .filter((one) => ULID.test(one.runId) && one.distance <= REVIEW_MATCH_MS)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, REVIEW_CANDIDATES)
    .map(({ runId, agent }) => ({ runId, agent }))
}

// A run that reviewed the change names the review it posted its findings in.
export const runReviewId = (run) => run?.review_changes_result?.review_id ?? null
