import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'src', 'main', 'assets')
const html = readFileSync(join(root, 'index.html'), 'utf8')
const app = readFileSync(join(root, 'app.js'), 'utf8')
const styles = readFileSync(join(root, 'styles.css'), 'utf8')
const markdown = readFileSync(join(root, 'markdown.js'), 'utf8')
const mainRoot = join(root, '..')
const debugManifest = readFileSync(join(mainRoot, 'AndroidManifest.xml'), 'utf8')
const releaseManifest = readFileSync(join(mainRoot, 'AndroidManifest.release.xml'), 'utf8')
const activity = readFileSync(join(mainRoot, 'java', 'org', 'dshcommunity', 'remote', 'MainActivity.java'), 'utf8')
const packageRoot = join(root, '..', '..', '..', '..')
const repoRoot = join(packageRoot, '..', '..')
const buildScript = readFileSync(join(packageRoot, 'build.ps1'), 'utf8')
const buildEntrypoint = readFileSync(join(repoRoot, 'build-android.ps1'), 'utf8')
const buildProfile = JSON.parse(readFileSync(join(repoRoot, 'android-build-profile.json'), 'utf8'))
const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))

test('conversation is a full-screen page without a duplicate bottom navigation', () => {
  assert.match(html, /<section id="sessionPage" class="session-page" hidden/)
  assert.doesNotMatch(html, /id="sessionDialog"/)
  assert.doesNotMatch(html, /class="bottom-nav session-nav"/)
  assert.match(html, /id="sendModeButton"/)
  assert.match(app, /\$\('app'\)\.inert = true/)
  assert.match(app, /\$\('app'\)\.inert = false/)
})

test('composer forwards both queue and steer instead of hard-coding queue', () => {
  assert.match(app, /promptMode: 'queue'/)
  assert.match(app, /state\.promptMode = 'steer'/)
  assert.match(app, /state\.promptMode = 'queue'/)
  assert.match(app, /mode, content/)
  assert.doesNotMatch(app, /sessionId: state\.currentSession\.sessionId, mode: 'queue', content \}\)/)
})

test('model picker separates base models from reasoning effort in one sheet', () => {
  assert.match(app, /function showModelSheet\(\)/)
  assert.match(app, /模型与思考等级/)
  assert.match(app, /sectionTitle\('模型'\)/)
  assert.match(app, /sectionTitle\('思考等级'\)/)
  assert.match(app, /const efforts = reasoning\?\.efforts \|\| \[\]/)
  assert.match(app, /应用选择/)
  assert.doesNotMatch(app, /title: `\$\{model\.name \|\| model\.id\}\$\{effort\.name/)
})

test('live turn events update the running composer state', () => {
  assert.match(app, /frame\.event\.type === 'turn\/start'\) setSessionRunning\(true\)/)
  assert.match(app, /frame\.event\.type === 'turn\/end'\) setSessionRunning\(false\)/)
})

test('conversation follows Harness node hierarchy instead of tool chips in empty assistant bubbles', () => {
  assert.match(html, /id="sessionApproval"/)
  assert.match(html, /src="markdown\.js"/)
  assert.match(app, /kind: 'tool'/)
  assert.match(app, /function toolNode\(row\)/)
  assert.match(app, /function errorNode\(row\)/)
  assert.match(app, /function contextNode\(row\)/)
  assert.match(app, /startsWith\('<system-reminder>'\)/)
  assert.doesNotMatch(app, /tool-strip/)
  assert.doesNotMatch(app, /调用工具：/)
  assert.doesNotMatch(app, /row\.arguments/)
})

test('bundled Markdown renderer formats common agent output and rejects executable URLs', () => {
  const context = {}
  context.globalThis = context
  vm.runInNewContext(markdown, context)
  const rendered = context.DshMarkdown.renderMarkdown('## 状态\n\n- **结果**：`ok`\n\n[危险](javascript:alert(1))')
  assert.match(rendered, /<h2>状态<\/h2>/)
  assert.match(rendered, /<strong>结果<\/strong>/)
  assert.match(rendered, /<code>ok<\/code>/)
  assert.doesNotMatch(rendered, /javascript:/)
  assert.doesNotMatch(rendered, /<script/i)
})

test('task list supports search, workspace groups, pinning and host archive semantics', () => {
  assert.match(html, /id="taskSearch"/)
  assert.match(app, /function workspaceForSession\(/)
  assert.match(app, /className = 'task-group'/)
  assert.match(app, /className = 'session-swipe-actions'/)
  assert.match(app, /workspace\.archiveSession/)
  assert.match(app, /localStorage/)
})

test('initial release hides unsupported extension entry points', () => {
  assert.match(html, /<button data-view="git" hidden>/)
  assert.match(html, /<button data-view="ssh" hidden>/)
  assert.match(html, /<button id="pluginsButton"[^>]*hidden>/)
})

test('workspace groups persist collapse state while search temporarily expands matches', () => {
  assert.match(app, /collapsedWorkspaceIds: new Set\(\)/)
  assert.match(app, /function collapseStorageKey\(\)/)
  assert.match(app, /function loadCollapsedWorkspaces\(\)/)
  assert.match(app, /const collapsed = !query && state\.collapsedWorkspaceIds\.has\(groupKey\)/)
  assert.match(app, /setAttribute\('aria-expanded', String\(!collapsed\)\)/)
  assert.match(styles, /\.task-group-toggle/)
  assert.match(styles, /\.task-group > \.stack\[hidden\]\s*\{\s*display:\s*none;/)
  assert.match(activity, /settings\.setDomStorageEnabled\(true\)/)
})

test('new session starts from the task page without inheriting an old session', () => {
  assert.match(app, /function startNewSessionFlow\(\)/)
  assert.match(app, /\$\('newSession'\)\.onclick = \(\) => startNewSessionFlow\(\)/)
  assert.match(app, /async function createSessionInWorkspace\(workspace, options = \{\}\)/)
  assert.doesNotMatch(app, /state\.currentSession\?\.agentPreset \? \{ agentPreset/)
  assert.match(app, /showWorkspaceSheet\(true\)/)
  assert.match(html, /<input id="attachmentInput"[\s\S]*?<\/footer>\s*<\/section>\s*<section id="controlSheet"/)
  assert.match(app, /fillWorkspaceSelect\(\)[\s\S]{0,180}void openSession\(item\)/)
  assert.doesNotMatch(app, /await openSession\(item\)/)
  assert.match(app, /const historySeq = \+\+state\.sessionHistorySeq/)
  assert.match(app, /const historyIsCurrent = \(\) => historySeq === state\.sessionHistorySeq/)
  assert.match(app, /if \(!historyIsCurrent\(\)\) return/)
  assert.match(app, /catch \(error\) \{\s*if \(showError && historyIsCurrent\(\)\)/)
})

test('task actions follow the standard left-swipe and right-side action layout', () => {
  assert.match(app, /const distance = Math\.min\(0, Math\.max\(-132, lastX - startX\)\)/)
  assert.match(app, /const opened = startX - lastX >= 56/)
  assert.match(app, /wrapper\.classList\.remove\('open'\)/)
  assert.match(styles, /\.session-swipe-actions \{[^}]*inset: 0 0 0 auto/)
  assert.match(styles, /\.session-swipe\.open \.row-card \{ transform: translateX\(-124px\)/)
})

test('conversation context meter uses authoritative pressure and breakdown projections', () => {
  assert.match(html, /id="contextMeterButton"/)
  assert.match(html, /id="contextMeterPanel"/)
  assert.match(app, /projectedTokens \?\? pressure\.pressureTokens/)
  assert.match(app, /contextPressure/)
  assert.match(app, /contextBreakdown/)
  assert.match(app, /frame\.type === 'session\/projection'/)
  assert.match(html, /系统提示词/)
  assert.match(html, /对话消息/)
})

test('workspace chooser browses host directories and creates a workspace before a session', () => {
  assert.match(html, /id="directoryBrowser"/)
  assert.match(app, /host\.listDirectory/)
  assert.match(app, /workspace\.create/)
  assert.match(app, /session\.create/)
  assert.match(app, /listing\.crumbs/)
  assert.match(app, /listing\.entries/)
})

test('workspace chooser supports drives and bounded folder-only search under the current directory', () => {
  assert.match(html, /id="directoryDrives"/)
  assert.match(html, /id="directorySearch"/)
  assert.match(app, /host\.listDrives/)
  assert.match(app, /host\.searchDirectories/)
  assert.match(app, /state\.directoryListing = null[\s\S]*directoryPath'\)\.textContent = ''/)
  assert.match(app, /path: state\.directoryListing\.path, query/)
  assert.match(app, /result\.directories/)
  assert.doesNotMatch(app, /result\.files/)
  assert.match(app, /entry\.isDirectory === true/)
  assert.match(app, /entry\.type === 'directory'/)
})

test('queue dock follows authoritative mux snapshots and exposes all queue actions', () => {
  assert.match(html, /id="queuePanel"/)
  assert.match(app, /frame\.type === 'session\/queue'/)
  assert.match(app, /action: \{ kind: 'edit'/)
  assert.match(app, /updateQueuedItem\(item\.id, \{ kind: 'remove' \}\)/)
  assert.match(app, /updateQueuedItem\(item\.id, \{ kind: 'steer' \}\)/)
  assert.match(app, /function moveQueuedItem\(/)
})

test('queue mirror re-baselines on relay generations and queue action conflicts', () => {
  assert.match(app, /function requestEventsBaseline\(\)/)
  assert.match(app, /type: 'stream\.subscribe'/)
  assert.match(app, /stream: 'events\.mux'/)
  assert.match(app, /frame\.type === 'session\/subscribed'/)
  assert.match(app, /state\.queuesBySession\.delete\(frame\.sessionId\)/)
  assert.match(app, /void refreshOpenSessionHistory\(frame\.sessionId, false\)/)
  assert.match(app, /error\.code === 'queue-item-not-found'/)
  assert.match(app, /requestEventsBaseline\(\)[\s\S]{0,100}renderQueuePanel\(\)/)
})

test('queue dock defaults to a compact collapsed and accessible icon-only layout', () => {
  assert.match(app, /queueExpanded: false/)
  assert.match(html, /id="toggleQueue"[^>]*aria-controls="queueList"[^>]*aria-expanded="false"/)
  assert.match(app, /setAttribute\('aria-expanded', String\(state\.queueExpanded\)\)/)
  assert.match(styles, /\.queue-list\[hidden\]\s*\{\s*display:\s*none;/)
  assert.match(styles, /\.queue-item-title\s*\{[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s)
  assert.match(styles, /\.queue-list\s*\{[^}]*max-height:\s*180px;/s)
  assert.match(styles, /\.queue-item\s*\{[^}]*height:\s*36px;/s)
  assert.match(app, /className = 'queue-icon-action'/)
  assert.match(app, /button\.setAttribute\('aria-label', label\)/)
  assert.match(app, /button\.appendChild\(queueIcon\(icon\)\)/)
  assert.doesNotMatch(app, /className = 'queue-item-meta'/)
})

test('composer grows from one line to at most five and resets after programmatic changes', () => {
  assert.match(html, /id="promptInput" rows="1"/)
  assert.match(app, /function composerTextareaLayout\(scrollHeight, lineHeight\)/)
  assert.match(app, /const maxHeight = oneLine \* 5/)
  assert.match(app, /function resizePromptInput\(\)/)
  assert.match(app, /field\.style\.height = 'auto'/)
  assert.match(app, /field\.style\.overflowY = overflowY/)
  assert.match(app, /\$\('promptInput'\)\.oninput = \(\) => resizePromptInput\(\)/)
  assert.match(app, /\$\('promptInput'\)\.value = ''[\s\S]*?resizePromptInput\(\)/)
  assert.match(styles, /\.composer textarea\s*\{[^}]*height:\s*1\.4em;[^}]*min-height:\s*1\.4em;[^}]*max-height:\s*7em;/s)
})

test('composer actions stay in one compact row with short state labels and icon-only primary actions', () => {
  assert.match(html, /<div class="composer-actions" aria-label="会话操作">[\s\S]*id="attachmentButton"[\s\S]*id="permissionButton"[\s\S]*id="modelButton"[\s\S]*id="cancelSession"[\s\S]*id="sendPrompt"[\s\S]*<\/div>/)
  assert.doesNotMatch(html, /class="composer-toolbar"/)
  assert.doesNotMatch(html, /class="composer-controls"/)
  assert.match(html, /id="attachmentButton"[^>]*aria-label="添加附件"[^>]*>[\s\S]*?<svg/)
  assert.match(html, /id="cancelSession"[^>]*aria-label="停止当前轮次"[^>]*>[\s\S]*?<svg/)
  assert.match(html, /id="sendPrompt"[^>]*aria-label="发送消息"[^>]*>[\s\S]*?<svg/)
  assert.match(app, /function compactPermissionLabel\(value\)/)
  assert.match(app, /'danger-full-access': '全权限'/)
  assert.match(app, /function compactModelLabel\(value\)/)
  assert.match(app, /replace\(\/\^DeepSeek\[-\\s_\]\*\/i, ''\)/)
  assert.match(styles, /\.composer-actions\s*\{[^}]*display:\s*flex;[^}]*overflow:\s*hidden;/s)
  assert.match(styles, /\.composer-actions \.tool-button, \.composer-actions \.action\s*\{[^}]*height:\s*26px;[^}]*min-height:\s*26px;/s)
  assert.match(styles, /\.composer-actions \.composer-model-button\s*\{[^}]*flex:\s*1 1 64px;[^}]*min-width:\s*42px;/s)
})

test('long Markdown is collapsible and fenced code blocks get copy controls', () => {
  assert.match(app, /function decorateCodeBlocks\(/)
  assert.match(app, /DshRemoteNative\?\.copyText/)
  assert.match(app, /navigator\.clipboard/)
  assert.match(app, /classList\.toggle\('collapsed'/)
  assert.match(markdown, /class="language-/)
})

test('SSH failures are classified instead of dumping host stack traces', () => {
  assert.match(app, /function safeSshError\(/)
  assert.match(app, /SSH 配置解密失败/)
  assert.doesNotMatch(app, /sshList'\)\.textContent = error\.message/)
})

test('pairing keeps external App Links strict while explicit debug scans accept same-domain HTTPS', () => {
  assert.match(debugManifest, /android:scheme="dshremote"/)
  assert.match(releaseManifest, /android:autoVerify="true"/)
  assert.match(releaseManifest, /android:scheme="https"/)
  assert.match(releaseManifest, /android:pathPrefix="\/dsh-remote\/pair"/)
  assert.match(releaseManifest, /org\.dshcommunity\.remote\.APP_LINK_HOST/)
  assert.doesNotMatch(releaseManifest, /dshremote:\/\/pair/)
  assert.match(activity, /boolean scannedHttpsPair = allowRetarget[\s\S]*trustedAppLinkHost == null[\s\S]*"https"\.equals\(uri\.getScheme\(\)\)/)
  assert.match(activity, /if \(!customPair && !verifiedPair && !scannedHttpsPair\) return false/)
  assert.match(activity, /\(verifiedPair \|\| scannedHttpsPair\)[\s\S]*relayUri\.getHost\(\)\.equalsIgnoreCase\(uri\.getHost\(\)\)/)
  assert.match(activity, /acceptPairingUri\(uri, false\)/)
  assert.match(activity, /acceptPairingUri\(Uri\.parse\(value\), true\)/)
})

test('APK WebView stays on the bundled asset and cannot consume query credentials', () => {
  assert.match(activity, /"\/android_asset\/index\.html"\.equals\(target\.getPath\(\)\)/)
  assert.match(activity, /trustedAppLinkHost\.equalsIgnoreCase\(uri\.getHost\(\)\)/)
  assert.match(app, /if \(window\.DshRemoteNative\) \{[\s\S]*catch \(_\) \{ return \{\} \}/)
  assert.match(app, /const query = new URLSearchParams\(location\.search\)/)
})

test('settings provides an in-app QR scanner with native credential validation', () => {
  assert.match(html, /id="scanQrButton"/)
  assert.match(html, /id="scanVideo"[^>]*autoplay[^>]*playsinline/)
  assert.match(html, /src="jsQR\.js"/)
  assert.match(html, /id="scanImageInput"[^>]*accept="image\/\*"/)
  assert.match(app, /window\.jsQR\(/)
  assert.match(app, /navigator\.mediaDevices\.getUserMedia/)
  assert.match(app, /DshRemoteNative\.acceptPairingUri\(value\)/)
  assert.match(app, /二维码格式无效，或配对链接与 Relay 域名不一致/)
  assert.doesNotMatch(app, /二维码无效、已过期，或不属于当前 Relay/)
  assert.doesNotMatch(app, /BarcodeDetector/)
  assert.match(activity, /PermissionRequest\.RESOURCE_VIDEO_CAPTURE/)
  assert.match(activity, /@JavascriptInterface public boolean acceptPairingUri/)
  assert.match(debugManifest, /android\.permission\.CAMERA/)
  assert.match(releaseManifest, /android\.permission\.CAMERA/)
})

test('Android pairing is scan-only and keeps Relay configuration on the desktop plugin', () => {
  assert.match(html, /id="bindingStatus"/)
  assert.doesNotMatch(html, /id="relayInput"/)
  assert.doesNotMatch(html, /id="hostInput"/)
  assert.doesNotMatch(html, /id="tokenInput"/)
  assert.doesNotMatch(app, /\$\('relayInput'\)/)
  assert.doesNotMatch(app, /\$\('tokenInput'\)/)
})

test('QR decoder is pinned, integrity checked and bundled with its license', () => {
  assert.equal(packageJson.dependencies.jsqr, '1.4.0')
  assert.match(buildScript, /BC40C8A15196236B2314DB0856F72CA0B49980CD5413B8C852A7349F5FEE0859/)
  assert.match(buildScript, /Join-Path \$assetsOut 'jsQR\.js'/)
  assert.match(buildScript, /Join-Path \$assetsOut 'jsqr\.LICENSE\.txt'/)
})

test('launcher and in-app brand use the canonical black whale mark', () => {
  assert.match(debugManifest, /android:icon="@mipmap\/ic_launcher"/)
  assert.match(releaseManifest, /android:icon="@mipmap\/ic_launcher"/)
  assert.match(html, /class="brand-mark"[^>]*>[\s\S]*remote-link\.svg/)
  assert.match(readFileSync(join(mainRoot, 'res', 'drawable', 'ic_launcher_foreground.xml'), 'utf8'), /android:fillColor="#FF000000"/)
  assert.match(readFileSync(join(root, 'remote-link.svg'), 'utf8'), /aria-label="DeepSeek"[\s\S]*fill="#000"/)
})

test('canonical Android entrypoint pins package, label, icon, version and debug signer', () => {
  assert.equal(buildProfile.packageName, 'org.dshcommunity.remote')
  assert.equal(buildProfile.applicationLabel, 'DSH Remote Companion')
  assert.equal(buildProfile.versionName, packageJson.version)
  assert.equal(buildProfile.brandResources.length, 4)
  for (const resource of buildProfile.brandResources) {
    const normalizedText = readFileSync(join(repoRoot, resource.path), 'utf8').replace(/\r\n?/g, '\n')
    const actualSha256 = createHash('sha256').update(normalizedText, 'utf8').digest('hex').toUpperCase()
    assert.equal(resource.sha256, actualSha256)
  }
  assert.match(buildProfile.debugCertificateSha256, /^[0-9A-F]{64}$/)
  assert.match(buildEntrypoint, /Android build identity mismatch/)
  assert.match(buildEntrypoint, /apksigner\.bat'\) verify --print-certs/)
  assert.match(buildScript, /Use the repository root build-android\.ps1 entrypoint/)
  assert.doesNotMatch(buildScript, /-genkeypair/)
  assert.match(buildScript, /LastWriteTimeUtc = \$fixedZipTimestamp/)
  assert.match(buildScript, /--v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled true --v4-signing-enabled false/)
  assert.match(buildEntrypoint, /Where-Object \{ \$_\.Name -match '\\\.\(\?:apk\|idsig\)\$' \}/)
  assert.match(buildEntrypoint, /Remove-Item -LiteralPath \$intermediateRoot -Recurse -Force/)
})

test('release QR validation accepts only its declared HTTPS relay host', () => {
  assert.match(activity, /boolean customPair = trustedAppLinkHost == null/)
  assert.match(activity, /trustedAppLinkHost\.equalsIgnoreCase\(uri\.getHost\(\)\)/)
  assert.match(activity, /relayUri\.getHost\(\)\.equalsIgnoreCase\(uri\.getHost\(\)\)/)
  assert.match(activity, /relayUri\.getUserInfo\(\) != null/)
  assert.match(activity, /acceptPairingUri\(uri, false\)/)
  assert.match(activity, /acceptPairingUri\(Uri\.parse\(value\), true\)/)
})
