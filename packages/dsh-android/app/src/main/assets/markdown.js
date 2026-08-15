/*
 * Browser build of the repository's existing compact Markdown renderer
 * (packages/dsh-aionui-panel/src/client/preview/markdown.ts). Keep this small,
 * dependency-free and safe for WebView: raw HTML is always escaped and only
 * renderer-owned tags are emitted.
 */
(() => {
  'use strict'

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  function safeUrl(raw) {
    const trimmed = String(raw).trim()
    if (!trimmed) return null
    if (trimmed.startsWith('#')) return trimmed
    const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed)
    if (!scheme) return trimmed
    const name = scheme[1].toLowerCase()
    return name === 'http' || name === 'https' || name === 'mailto' ? trimmed : null
  }

  function renderInline(text) {
    let out = ''
    let index = 0
    while (index < text.length) {
      const char = text[index]
      if (char === '`') {
        const end = text.indexOf('`', index + 1)
        if (end !== -1) {
          out += `<code>${escapeHtml(text.slice(index + 1, end))}</code>`
          index = end + 1
          continue
        }
      }
      // Remote session images are intentionally not fetched by WebView. Keep
      // their accessible label, while attachments stay in the controlled API.
      if (char === '!' && text[index + 1] === '[') {
        const close = text.indexOf('](', index + 2)
        const end = close === -1 ? -1 : text.indexOf(')', close + 2)
        if (end !== -1) {
          out += escapeHtml(text.slice(index + 2, close))
          index = end + 1
          continue
        }
      }
      if (char === '[') {
        const close = text.indexOf('](', index + 1)
        const end = close === -1 ? -1 : text.indexOf(')', close + 2)
        if (end !== -1) {
          const label = text.slice(index + 1, close)
          const href = safeUrl(text.slice(close + 2, end))
          out += href === null
            ? renderInline(label)
            : `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${renderInline(label)}</a>`
          index = end + 1
          continue
        }
      }
      if (char === '*' && text[index + 1] === '*') {
        const end = text.indexOf('**', index + 2)
        if (end !== -1) {
          out += `<strong>${renderInline(text.slice(index + 2, end))}</strong>`
          index = end + 2
          continue
        }
      }
      if (char === '*' && text[index - 1] !== '*' && text[index + 1] !== '*') {
        const end = text.indexOf('*', index + 1)
        if (end !== -1 && text[end + 1] !== '*') {
          out += `<em>${renderInline(text.slice(index + 1, end))}</em>`
          index = end + 1
          continue
        }
      }
      if (char === '~' && text[index + 1] === '~') {
        const end = text.indexOf('~~', index + 2)
        if (end !== -1) {
          out += `<del>${renderInline(text.slice(index + 2, end))}</del>`
          index = end + 2
          continue
        }
      }
      out += escapeHtml(char)
      index += 1
    }
    return out
  }

  function splitTableRow(line) {
    const trimmed = line.trim()
    const inner = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed
    const withoutTrailing = inner.endsWith('|') ? inner.slice(0, -1) : inner
    return withoutTrailing.split('|').map(cell => cell.trim())
  }

  function renderMarkdown(source) {
    const lines = String(source).replace(/\r\n/g, '\n').split('\n')
    const out = []
    let index = 0
    let paragraph = []
    const flushParagraph = () => {
      if (!paragraph.length) return
      out.push(`<p>${renderInline(paragraph.join('\n'))}</p>`)
      paragraph = []
    }

    while (index < lines.length) {
      const line = lines[index]
      const fence = /^```([\w+-]*)\s*$/.exec(line)
      if (fence) {
        flushParagraph()
        const language = fence[1] || ''
        index += 1
        const code = []
        while (index < lines.length && !/^```\s*$/.test(lines[index])) {
          code.push(lines[index])
          index += 1
        }
        if (index < lines.length) index += 1
        const languageClass = language ? ` class="language-${escapeHtml(language)}"` : ''
        out.push(`<pre${languageClass}><code>${escapeHtml(code.join('\n'))}</code></pre>`)
        continue
      }
      const heading = /^(#{1,6})\s+(.*)$/.exec(line)
      if (heading) {
        flushParagraph()
        const level = heading[1].length
        out.push(`<h${level}>${renderInline(heading[2] || '')}</h${level}>`)
        index += 1
        continue
      }
      if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
        flushParagraph(); out.push('<hr />'); index += 1; continue
      }
      if (line.includes('|') && index + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[index + 1]) && lines[index + 1].includes('-')) {
        flushParagraph()
        const header = splitTableRow(line)
        const rows = []
        index += 2
        while (index < lines.length && lines[index].includes('|')) {
          rows.push(splitTableRow(lines[index])); index += 1
        }
        out.push(`<table><thead><tr>${header.map(cell => `<th>${renderInline(cell)}</th>`).join('')}</tr></thead>`)
        if (rows.length) out.push(`<tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${renderInline(cell)}</td>`).join('')}</tr>`).join('')}</tbody>`)
        out.push('</table>')
        continue
      }
      if (/^>\s?/.test(line)) {
        flushParagraph()
        const body = []
        while (index < lines.length) {
          const quote = /^>\s?(.*)$/.exec(lines[index])
          if (!quote) break
          body.push(quote[1] || ''); index += 1
        }
        out.push(`<blockquote><p>${body.map(renderInline).join('<br />')}</p></blockquote>`)
        continue
      }
      if (/^\s*[-*+]\s+/.test(line)) {
        flushParagraph()
        const items = []
        while (index < lines.length) {
          const item = /^\s*[-*+]\s+(.*)$/.exec(lines[index])
          if (!item) break
          const task = /^\[([ xX])\]\s+(.*)$/.exec(item[1] || '')
          items.push(task
            ? `<li class="task-item"><input type="checkbox" disabled${task[1].toLowerCase() === 'x' ? ' checked' : ''}>${renderInline(task[2] || '')}</li>`
            : `<li>${renderInline(item[1] || '')}</li>`)
          index += 1
        }
        out.push(`<ul>${items.join('')}</ul>`)
        continue
      }
      if (/^\s*\d+[.)]\s+/.test(line)) {
        flushParagraph()
        const items = []
        while (index < lines.length) {
          const item = /^\s*\d+[.)]\s+(.*)$/.exec(lines[index])
          if (!item) break
          items.push(`<li>${renderInline(item[1] || '')}</li>`); index += 1
        }
        out.push(`<ol>${items.join('')}</ol>`)
        continue
      }
      if (!line.trim()) {
        flushParagraph(); index += 1; continue
      }
      paragraph.push(line)
      index += 1
    }
    flushParagraph()
    return out.join('\n')
  }

  globalThis.DshMarkdown = Object.freeze({ escapeHtml, safeUrl, renderInline, renderMarkdown })
})()
