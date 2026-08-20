import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listDriveRoots, searchDirectories } from '../src/host-directory.ts'

const temporary: string[] = []

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('remote folder discovery', () => {
  it('reports only drive roots whose metadata probe succeeds', async () => {
    const touched: string[] = []
    const roots = await listDriveRoots('win32', async (path) => {
      touched.push(path)
      if (path !== 'C:\\' && path !== 'E:\\') throw new Error('missing')
    })
    expect(roots).toEqual(['C:\\', 'E:\\'])
    expect(touched).toHaveLength(26)
  })

  it('searches only directories below the chosen root and never returns files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-folder-search-'))
    temporary.push(root)
    mkdirSync(join(root, 'Current', 'Nested target'), { recursive: true })
    mkdirSync(join(root, 'Sibling target'), { recursive: true })
    mkdirSync(join(root, 'node_modules', 'Hidden target'), { recursive: true })
    writeFileSync(join(root, 'target-file.txt'), 'not a folder')

    const result = await searchDirectories(join(root, 'Current'), 'target')
    expect(result.directories.map(item => item.name)).toEqual(['Nested target'])
    expect(result.directories.every(item => item.path.startsWith(join(root, 'Current')))).toBe(true)
    expect(JSON.stringify(result)).not.toContain('target-file.txt')
    expect(JSON.stringify(result)).not.toContain('Sibling target')
  })

  it('refuses empty and overlong folder queries', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-folder-search-'))
    temporary.push(root)
    await expect(searchDirectories(root, '   ')).rejects.toThrow(/1 to 80/)
    await expect(searchDirectories(root, 'x'.repeat(81))).rejects.toThrow(/1 to 80/)
  })

  it('does not expose an unavailable host path in relay errors', async () => {
    const unavailable = join(tmpdir(), 'dsh-path-that-does-not-exist', 'private-folder-name')
    const error = await searchDirectories(unavailable, 'target').catch(reason => reason as Error)
    expect(error.message).toBe('directory search root is unavailable')
    expect(error.message).not.toContain('private-folder-name')
  })
})
