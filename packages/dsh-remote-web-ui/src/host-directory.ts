import { access, readdir, realpath, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'

const SEARCH_DEPTH_LIMIT = 10
const SEARCH_SCAN_LIMIT = 4_000
const SEARCH_HIT_LIMIT = 100
const SEARCH_SKIP_NAMES = new Set([
  '.git', '.pnpm', 'node_modules', 'dist', 'build', '$recycle.bin', 'system volume information',
])

export interface DirectorySearchResult {
  root: string
  query: string
  directories: Array<{ name: string; path: string }>
  scanned: number
  truncated: boolean
}

/**
 * Return filesystem roots without enumerating their contents. On Windows the
 * probe touches only A:\\ through Z:\\; the phone opens a root explicitly.
 */
export async function listDriveRoots(
  platform = process.platform,
  probe: (path: string) => Promise<void> = async path => { await access(path) },
): Promise<string[]> {
  if (platform !== 'win32') return ['/']
  const roots = Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}:\\`)
  const checked = await Promise.all(roots.map(async root => {
    try {
      await probe(root)
      return root
    } catch {
      return undefined
    }
  }))
  return checked.filter((root): root is string => root !== undefined)
}

/**
 * Bounded directory-name search rooted at exactly the directory the user is
 * viewing. Files are never statted, read, matched, or returned.
 */
export async function searchDirectories(root: string, rawQuery: string): Promise<DirectorySearchResult> {
  if (typeof root !== 'string' || root.trim() === '' || root.length > 2_048) throw new Error('invalid directory search root')
  const query = typeof rawQuery === 'string' ? rawQuery.trim() : ''
  if (query === '' || query.length > 80) throw new Error('folder query must contain 1 to 80 characters')
  let canonicalRoot: string
  try {
    canonicalRoot = await realpath(root)
    const rootInfo = await stat(canonicalRoot)
    if (!rootInfo.isDirectory()) throw new Error('not a directory')
  } catch {
    // Do not echo a host path through the relay error channel.
    throw new Error('directory search root is unavailable')
  }

  const needle = query.toLocaleLowerCase()
  const directories: DirectorySearchResult['directories'] = []
  const queue: Array<{ path: string; depth: number }> = [{ path: canonicalRoot, depth: 0 }]
  let scanned = 0
  let truncated = false

  while (queue.length > 0 && !truncated) {
    const current = queue.shift()
    if (current === undefined) break
    let entries: Dirent[]
    try {
      entries = await readdir(current.path, { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const lowerName = entry.name.toLocaleLowerCase()
      if (entry.name.startsWith('.') || SEARCH_SKIP_NAMES.has(lowerName)) continue
      scanned += 1
      if (scanned > SEARCH_SCAN_LIMIT) {
        truncated = true
        break
      }
      const path = join(current.path, entry.name)
      if (lowerName.includes(needle)) {
        directories.push({ name: entry.name, path })
        if (directories.length >= SEARCH_HIT_LIMIT) {
          truncated = true
          break
        }
      }
      if (current.depth < SEARCH_DEPTH_LIMIT) queue.push({ path, depth: current.depth + 1 })
    }
  }

  directories.sort((left, right) => {
    const leftName = left.name.toLocaleLowerCase()
    const rightName = right.name.toLocaleLowerCase()
    const rank = (name: string): number => name === needle ? 0 : name.startsWith(needle) ? 1 : 2
    return rank(leftName) - rank(rightName) || left.path.length - right.path.length || left.path.localeCompare(right.path)
  })
  return { root: canonicalRoot, query, directories, scanned, truncated }
}
