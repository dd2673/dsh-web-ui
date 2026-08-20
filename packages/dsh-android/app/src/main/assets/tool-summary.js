((global) => {
  const MAX_SUMMARY_LENGTH = 120

  const TITLES = {
    bash: 'Bash', pwsh: 'Pwsh', read: 'Read', write: 'Write', edit: 'Edit',
    grep: 'Grep', glob: 'Glob', web_search: 'Search', web_fetch: 'Fetch',
    run_code: 'Code', job_output: 'Job output',
  }

  const TOOL_KEYS = {
    bash: ['description', 'summary'], pwsh: ['description', 'summary'], read: ['description', 'summary'],
    write: ['description', 'summary'], edit: ['description', 'summary'], grep: ['description', 'query', 'pattern', 'summary'],
    glob: ['description', 'pattern', 'summary'], web_search: ['description', 'query', 'summary'],
    web_fetch: ['description', 'summary'], run_code: ['description', 'summary'], job_output: ['description', 'summary'],
  }

  function parseArguments(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value
    if (typeof value !== 'string' || value === '') return null
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
    } catch (_) { return null }
  }

  function boundedLine(value) {
    const line = String(value || '').split(/\r?\n/, 1)[0].replace(/\s+/g, ' ').trim()
    return line.length <= MAX_SUMMARY_LENGTH ? line : `${line.slice(0, MAX_SUMMARY_LENGTH - 1)}…`
  }

  function derive(name, argumentsValue, projectedSummary) {
    const toolName = typeof name === 'string' && name !== '' ? name : 'tool'
    const args = parseArguments(argumentsValue)
    const keys = TOOL_KEYS[toolName] || ['description', 'summary', 'query', 'pattern']
    const candidate = projectedSummary || (args && keys.map(key => args[key]).find(value => typeof value === 'string' && value !== ''))
    const summary = boundedLine(candidate)
    return { title: TITLES[toolName] || toolName, summary }
  }

  global.DshToolSummary = { derive }
})(globalThis)
