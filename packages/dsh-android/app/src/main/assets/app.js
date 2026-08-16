(() => {
  'use strict'

  const $ = id => document.getElementById(id)
  const RPC_DIRECT_MAX_CHARS = 96_000
  const RPC_CHUNK_CHARS = 48_000
  const RPC_CHUNK_MAX_COUNT = 160
  const ATTACHMENT_MAX_BYTES = 1024 * 1024
  const ATTACHMENT_MAX_COUNT = 4
  let scanStream = null
  let scanFrame = 0
  let scanBusy = false
  let scanLastAt = 0
  const state = {
    config: {}, socket: null, connected: false, authenticated: false,
    capabilities: new Set(), pending: new Map(), workspaces: [], sessions: [],
    currentSession: null, pendingApproval: null, pendingQuestion: null, reconnectTimer: null, reconnectAttempt: 0,
    historyEvents: [], models: null, presets: [], skills: [], permissions: null, attachments: [],
    promptMode: 'queue', sessionPageOpen: false, sessionHistorySeq: 0, archivedSessionIds: new Set(),
    pinnedSessionIds: new Set(), collapsedWorkspaceIds: new Set(), taskQuery: '', queuesBySession: new Map(), queueBusy: false,
    queueExpanded: false, directoryListing: null, directoryBusy: false, directoryDrives: [], directorySearchTimer: null,
    directorySearchSeq: 0, directorySessionOptions: {}, contextPressure: null, contextBreakdown: null,
    contextMeterOpen: false, projectionSeqs: new Map(),
  }

  function composerTextareaLayout(scrollHeight, lineHeight) {
    const oneLine = Math.max(1, lineHeight)
    const maxHeight = oneLine * 5
    return {
      height: Math.min(Math.max(scrollHeight, oneLine), maxHeight),
      overflowY: scrollHeight > maxHeight ? 'auto' : 'hidden',
    }
  }

  function resizePromptInput() {
    const field = $('promptInput')
    field.style.height = 'auto'
    const computedLineHeight = Number.parseFloat(getComputedStyle(field).lineHeight)
    const { height, overflowY } = composerTextareaLayout(
      field.scrollHeight,
      Number.isFinite(computedLineHeight) ? computedLineHeight : 18,
    )
    field.style.height = `${Math.ceil(height)}px`
    field.style.overflowY = overflowY
  }

  function setPromptInput(value) {
    $('promptInput').value = value
    resizePromptInput()
  }

  function nativeConfig() {
    if (window.DshRemoteNative) {
      try { return JSON.parse(window.DshRemoteNative.loadConfig()) }
      catch (_) { return {} }
    }
    // Query configuration is a browser-preview convenience only. The APK
    // always has DshRemoteNative and must never accept credentials from its
    // asset URL or another in-process navigation.
    const query = new URLSearchParams(location.search)
    return {
      relay: query.get('relay') || '', hostId: query.get('host') || '',
      deviceId: query.get('device') || 'browser-preview', token: query.get('token') || '',
    }
  }

  function deviceId() {
    if (state.config.deviceId) return state.config.deviceId
    try { return window.DshRemoteNative.deviceId() || 'android-device' } catch (_) { return 'android-device' }
  }

  function validConfig(config) {
    if (typeof config.relay !== 'string' || typeof config.hostId !== 'string' || typeof config.token !== 'string') return false
    if (config.hostId.length < 3 || config.token.length < 24) return false
    try {
      const url = new URL(config.relay)
      if (url.username || url.password) return false
      return url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname))
    } catch (_) { return false }
  }

  function websocketUrl(base) {
    const url = new URL(base)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const basePath = url.pathname.replace(/\/+$/, '')
    url.pathname = basePath.endsWith('/relay') ? basePath : `${basePath}/relay`
    url.search = ''
    url.hash = ''
    return url.toString()
  }

  async function startQrScanner() {
    const dialog = $('scanDialog')
    $('scanStatus').textContent = '正在启动摄像头…'
    if (!window.DshRemoteNative?.acceptPairingUri) {
      $('scanStatus').textContent = '扫码仅在 Android App 内可用。'
      dialog.showModal()
      return
    }
    if (typeof window.jsQR !== 'function') {
      $('scanStatus').textContent = '本地二维码解码器加载失败，请重新安装应用。'
      dialog.showModal()
      return
    }
    dialog.showModal()
    if (!navigator.mediaDevices?.getUserMedia) {
      $('scanStatus').textContent = '当前系统无法打开摄像头，可从相册选择二维码。'
      return
    }
    try {
      scanStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      })
      const video = $('scanVideo')
      video.srcObject = scanStream
      await video.play()
      $('scanStatus').textContent = '将二维码完整放入取景框；画面仅在本机识别。'
      scanFrame = requestAnimationFrame(scanQrFrame)
    } catch (error) {
      $('scanStatus').textContent = /denied|permission|notallowed/i.test(String(error?.message || error))
        ? '未获得摄像头权限，请在系统设置中允许后重试。'
        : '摄像头启动失败，可从相册选择二维码。'
    }
  }

  function decodeQrSource(source, sourceWidth, sourceHeight) {
    if (!sourceWidth || !sourceHeight || typeof window.jsQR !== 'function') return ''
    const canvas = $('scanCanvas')
    const scale = Math.min(1, 640 / Math.max(sourceWidth, sourceHeight))
    canvas.width = Math.max(1, Math.round(sourceWidth * scale))
    canvas.height = Math.max(1, Math.round(sourceHeight * scale))
    const context = canvas.getContext('2d', { willReadFrequently: true })
    context.drawImage(source, 0, 0, canvas.width, canvas.height)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
    return window.jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'attemptBoth' })?.data || ''
  }

  function acceptPairingValue(value) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 4096) return false
    if (window.DshRemoteNative.acceptPairingUri(value)) {
      $('scanStatus').textContent = '配对成功，正在连接…'
      stopQrScanner()
      $('scanDialog').close()
      $('settingsDialog').close()
      state.config = nativeConfig()
      loadLocalSessionPreferences()
      connect()
      return true
    }
    $('scanStatus').textContent = '二维码格式无效，或配对链接与 Relay 域名不一致。'
    return false
  }

  function scanQrFrame(now) {
    if (!scanStream || !$('scanDialog').open) return
    if (!scanBusy && now - scanLastAt >= 120 && $('scanVideo').readyState >= 2) {
      scanBusy = true
      scanLastAt = now
      try {
        const video = $('scanVideo')
        const value = decodeQrSource(video, video.videoWidth, video.videoHeight)
        if (value && acceptPairingValue(value)) return
      } catch (_) {
        $('scanStatus').textContent = '识别暂时失败，请保持二维码稳定。'
      } finally { scanBusy = false }
    }
    scanFrame = requestAnimationFrame(scanQrFrame)
  }

  function loadQrImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(new Error('read failed'))
      reader.onload = () => {
        const image = new Image()
        image.onerror = () => reject(new Error('image failed'))
        image.onload = () => resolve(image)
        image.src = String(reader.result || '')
      }
      reader.readAsDataURL(file)
    })
  }

  async function scanQrImage(file) {
    if (!file || typeof window.jsQR !== 'function') return
    $('scanStatus').textContent = '正在本机识别图片…'
    try {
      const image = await loadQrImage(file)
      const value = decodeQrSource(image, image.naturalWidth, image.naturalHeight)
      if (!value) $('scanStatus').textContent = '图片中未识别到二维码，请重新选择。'
      else acceptPairingValue(value)
    } catch (_) {
      $('scanStatus').textContent = '图片读取失败，请重新选择。'
    }
  }

  function stopQrScanner() {
    if (scanFrame) cancelAnimationFrame(scanFrame)
    scanFrame = 0
    scanStream?.getTracks().forEach(track => track.stop())
    scanStream = null
    scanBusy = false
    scanLastAt = 0
    $('scanVideo').srcObject = null
  }

  function setConnection(kind, text) {
    $('connectionText').textContent = text
    $('connectionDot').className = `dot ${kind}`
  }

  function connect() {
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer)
    if (state.socket) state.socket.close(1000, 'reconfigure')
    state.socket = null
    state.authenticated = false
    state.connected = false
    $('hostLabel').textContent = state.config.hostId || '未配置'
    if (!validConfig(state.config)) {
      setConnection('off', '等待配置')
      renderBindingStatus()
      if (!$('settingsDialog').open) $('settingsDialog').showModal()
      return
    }
    setConnection('', '正在连接 relay')
    let socket
    try { socket = new WebSocket(websocketUrl(state.config.relay)) }
    catch (error) { scheduleReconnect(String(error)); return }
    state.socket = socket
    socket.onopen = () => {
      state.connected = true
      socket.send(JSON.stringify({
        v: 1, type: 'hello', role: 'device', hostId: state.config.hostId,
        deviceId: deviceId(), token: state.config.token,
      }))
    }
    socket.onmessage = event => {
      try { handleMessage(JSON.parse(event.data)) } catch (_) {}
    }
    socket.onerror = () => setConnection('off', '网络连接失败')
    socket.onclose = event => {
      state.connected = false
      state.authenticated = false
      state.socket = null
      rejectPending(new Error(event.code === 4003 ? '安全凭据已失效，请重新扫描桌面端二维码' : 'relay 连接已断开'))
      if (event.code === 4003) {
        setConnection('off', 'token 已失效')
        $('runtimeDetail').textContent = '电脑端已轮换或撤销凭据，请重新扫描二维码。'
        return
      }
      scheduleReconnect('连接已断开')
    }
  }

  function scheduleReconnect(message) {
    setConnection('off', message)
    const delay = Math.min(60000, 1000 * 2 ** state.reconnectAttempt++)
    state.reconnectTimer = setTimeout(connect, delay)
  }

  function handleMessage(message) {
    if (!message || message.v !== 1) return
    if (message.type === 'hello.ack') {
      if (typeof message.deviceToken === 'string') {
        if (!/^[A-Za-z0-9_-]{43,128}$/.test(message.deviceToken)) {
          state.socket?.close(4003, 'invalid exchanged credential')
          return
        }
        const next = { ...state.config, deviceId: deviceId(), token: message.deviceToken }
        try {
          if (window.DshRemoteNative && !window.DshRemoteNative.saveConfig(JSON.stringify(next))) throw new Error('Keystore 保存失败')
          state.config = next
        } catch (_) {
          state.socket?.close(4003, 'credential storage failed')
          setConnection('off', '安全凭据保存失败')
          return
        }
      }
      state.authenticated = true
      state.reconnectAttempt = 0
      setConnection('on', 'relay 已鉴权')
      return
    }
    if (message.type === 'capabilities') {
      state.capabilities = new Set(Array.isArray(message.methods) ? message.methods : [])
      // A relay reconnect starts a new mux generation. Queue snapshots are
      // transient, so no item from the prior generation may survive it.
      state.queuesBySession.clear()
      renderQueuePanel()
      requestEventsBaseline()
      void refreshAll()
      return
    }
    if (message.type === 'status') {
      updateStatus(message)
      return
    }
    if (message.type === 'rpc.response') {
      const deferred = state.pending.get(message.messageId)
      if (!deferred) return
      state.pending.delete(message.messageId)
      const envelope = message.payload
      if (envelope?.result?.ok === true) deferred.resolve(envelope.result.value)
      else {
        const failure = envelope?.result?.error
        const error = new Error(failure?.message || '远程调用失败')
        if (typeof failure?.code === 'string') error.code = failure.code
        deferred.reject(error)
      }
      return
    }
    if (message.type === 'event') handleMux(message.payload)
    if (message.type === 'error') {
      const deferred = state.pending.get(message.messageId)
      if (deferred) { state.pending.delete(message.messageId); deferred.reject(new Error(message.message || message.code)) }
    }
  }

  function updateStatus(message) {
    const host = message.host || {}
    const running = message.hostConnected === true || host.dshState === 'running'
    $('runtimeTitle').textContent = running ? 'DeepSeek 正在运行' : 'DeepSeek 当前离线'
    $('runtimeDetail').textContent = running
      ? '官方插件长连接已建立，任务和 approval 会实时推送。'
      : 'Agent 以低功耗 long-poll 等待启动命令。'
    $('agentState').textContent = host.agentState === 'online' ? '在线' : '离线'
    if (message.actionResult) {
      $('actionResult').textContent = `${message.actionResult.action}: ${message.actionResult.message}`
      $('actionResult').className = message.actionResult.ok ? 'hint' : 'error'
    }
  }

  function rpc(method, payload = {}, forcedId) {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN || !state.authenticated)
      return Promise.reject(new Error('DeepSeek relay 尚未连接'))
    if (!state.capabilities.has(method)) return Promise.reject(new Error(`当前插件不支持 ${method}`))
    const messageId = forcedId || `android-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { state.pending.delete(messageId); reject(new Error('远程调用超时')) }, 20000)
      state.pending.set(messageId, {
        resolve: value => { clearTimeout(timer); resolve(value) },
        reject: error => { clearTimeout(timer); reject(error) },
      })
      try {
        const direct = JSON.stringify({ v: 1, type: 'rpc.request', messageId, method, payload })
        if (direct.length <= RPC_DIRECT_MAX_CHARS) {
          state.socket.send(direct)
          return
        }
        const serialized = JSON.stringify(payload)
        const chunkCount = Math.ceil(serialized.length / RPC_CHUNK_CHARS)
        if (chunkCount > RPC_CHUNK_MAX_COUNT) throw new Error('请求内容过大，请减少附件后重试')
        for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
          state.socket.send(JSON.stringify({
            v: 1,
            type: 'rpc.request.chunk',
            messageId,
            method,
            chunkIndex,
            chunkCount,
            data: serialized.slice(chunkIndex * RPC_CHUNK_CHARS, (chunkIndex + 1) * RPC_CHUNK_CHARS),
          }))
        }
      } catch (error) {
        state.pending.delete(messageId)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  function rejectPending(error) {
    for (const deferred of state.pending.values()) deferred.reject(error)
    state.pending.clear()
  }

  function requestEventsBaseline() {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN || !state.authenticated) return false
    // A subscription restarts the Host mux. Drop transient mirrors first so
    // only waits replayed by that authoritative generation remain actionable.
    state.pendingApproval = null
    state.pendingQuestion = null
    renderApproval()
    state.socket.send(JSON.stringify({
      v: 1,
      type: 'stream.subscribe',
      stream: 'events.mux',
      messageId: `mux-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    }))
    return true
  }

  function lifecycle(action) {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN || !state.authenticated) {
      $('actionResult').textContent = 'relay 尚未连接'
      return
    }
    const messageId = `life-${Date.now().toString(36)}`
    state.socket.send(JSON.stringify({ v: 1, type: 'lifecycle.request', messageId, action, expiresAt: Date.now() + 120000 }))
    $('actionResult').textContent = `${action} 已进入安全队列`
  }

  async function refreshAll() {
    const results = await Promise.allSettled([refreshWorkspacesAndTasks(), refreshSsh()])
    if (results[0].status === 'rejected') {
      $('taskList').className = 'stack empty'
      $('taskList').textContent = `会话同步失败：${results[0].reason?.message || '未知错误'}`
    }
    await refreshGit()
  }

  async function refreshWorkspacesAndTasks() {
    if (!state.capabilities.has('workspace.list') || !state.capabilities.has('session.list')) return
    const [workspaceResult, sessionResult] = await Promise.all([rpc('workspace.list'), rpc('session.list')])
    state.workspaces = workspaceResult?.items || []
    state.archivedSessionIds = new Set(workspaceResult?.archivedSessionIds || [])
    state.sessions = (sessionResult?.items || []).filter(item => item && item.sessionId)
    if (state.currentSession) {
      const refreshed = state.sessions.find(item => item.sessionId === state.currentSession.sessionId)
      if (refreshed) Object.assign(state.currentSession, refreshed)
      updateComposerState()
    }
    $('runningCount').textContent = String(state.sessions.filter(item => item.running).length)
    renderTasks()
    fillWorkspaceSelect()
  }

  function sessionTitle(item) {
    if (item?.blank === true) return '新会话'
    const projected = item?.projections?.values?.title
    if (typeof projected === 'string' && projected) return projected
    if (item.cwd) return item.cwd.replace(/\\/g, '/').split('/').filter(Boolean).pop() || item.cwd
    return '新会话'
  }

  function workspaceForSession(item) {
    return state.workspaces.find(workspace => Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(item?.sessionId))
      || state.workspaces.find(workspace => workspace.path === item?.cwd)
      || null
  }

  function pinStorageKey() {
    return `dsh-remote:pinned:${state.config.hostId || 'unconfigured'}`
  }

  function loadPinnedSessions() {
    try {
      const value = JSON.parse(localStorage.getItem(pinStorageKey()) || '[]')
      state.pinnedSessionIds = new Set(Array.isArray(value) ? value.filter(item => typeof item === 'string') : [])
    } catch (_) { state.pinnedSessionIds = new Set() }
  }

  function savePinnedSessions() {
    try { localStorage.setItem(pinStorageKey(), JSON.stringify([...state.pinnedSessionIds])) } catch (_) {}
  }

  function collapseStorageKey() {
    return `dsh-remote:collapsed-workspaces:${state.config.hostId || 'unconfigured'}`
  }

  function loadCollapsedWorkspaces() {
    try {
      const value = JSON.parse(localStorage.getItem(collapseStorageKey()) || '[]')
      state.collapsedWorkspaceIds = new Set(Array.isArray(value) ? value.filter(item => typeof item === 'string') : [])
    } catch (_) { state.collapsedWorkspaceIds = new Set() }
  }

  function saveCollapsedWorkspaces() {
    try { localStorage.setItem(collapseStorageKey(), JSON.stringify([...state.collapsedWorkspaceIds])) } catch (_) {}
  }

  function loadLocalSessionPreferences() {
    loadPinnedSessions()
    loadCollapsedWorkspaces()
  }

  function renderTasks() {
    const list = $('taskList')
    const recent = $('recentTasks')
    list.replaceChildren()
    recent.replaceChildren()
    const query = state.taskQuery.trim().toLocaleLowerCase('zh-CN')
    const visible = state.sessions.filter(item => !state.archivedSessionIds.has(item.sessionId))
      .filter(item => {
        if (!query) return true
        const workspace = workspaceForSession(item)
        return [sessionTitle(item), item.cwd, workspace?.title, workspace?.path]
          .some(value => String(value || '').toLocaleLowerCase('zh-CN').includes(query))
      })
    const ordered = [...visible].sort((a, b) => {
      const pinDelta = Number(state.pinnedSessionIds.has(b.sessionId)) - Number(state.pinnedSessionIds.has(a.sessionId))
      return pinDelta || (b.updatedAt || 0) - (a.updatedAt || 0)
    })
    if (!ordered.length) {
      list.className = 'stack empty'; list.textContent = query ? '没有匹配的会话。' : '暂无任务。'
      recent.className = 'stack empty'; recent.textContent = 'DeepSeek 在线后显示最近会话。'
      return
    }
    list.className = 'task-groups'; recent.className = 'stack'
    const groups = new Map()
    for (const item of ordered) {
      const workspace = workspaceForSession(item)
      const key = workspace?.workspaceId || workspace?.path || 'ungrouped'
      if (!groups.has(key)) groups.set(key, { workspace, items: [] })
      groups.get(key).items.push(item)
    }
    for (const [groupKey, group] of groups) {
      const section = document.createElement('section'); section.className = 'task-group'
      const heading = document.createElement('div'); heading.className = 'task-group-head'
      const collapsed = !query && state.collapsedWorkspaceIds.has(groupKey)
      const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'task-group-toggle'
      toggle.setAttribute('aria-expanded', String(!collapsed))
      toggle.setAttribute('aria-label', `${collapsed ? '展开' : '收起'}${group.workspace?.title || '其他会话'}`)
      const title = document.createElement('span'); title.className = 'task-group-title'; title.textContent = group.workspace?.title || '其他会话'
      const count = document.createElement('span'); count.className = 'task-group-count'; count.textContent = `${group.items.length} 个会话`
      toggle.append(title, count)
      toggle.onclick = () => {
        if (state.collapsedWorkspaceIds.has(groupKey)) state.collapsedWorkspaceIds.delete(groupKey)
        else state.collapsedWorkspaceIds.add(groupKey)
        saveCollapsedWorkspaces(); renderTasks()
      }
      heading.append(toggle)
      const rows = document.createElement('div'); rows.className = 'stack'
      rows.hidden = collapsed
      group.items.forEach(item => rows.appendChild(sessionCard(item, true)))
      section.append(heading, rows); list.appendChild(section)
    }
    ordered.slice(0, 3).forEach(item => recent.appendChild(sessionCard(item, false)))
  }

  function sessionCard(item, swipeActions = true) {
    const button = document.createElement('button')
    button.className = 'row-card'
    const top = document.createElement('div'); top.className = 'row-top'
    const title = document.createElement('span'); title.className = 'row-title'; title.textContent = sessionTitle(item)
    const pill = document.createElement('span'); pill.className = `pill${item.running ? ' running' : ''}`; pill.textContent = item.running ? '运行中' : '空闲'
    const meta = document.createElement('div'); meta.className = 'row-meta'; meta.textContent = `${item.cwd || '默认工作区'} · ${formatTime(item.updatedAt)}`
    top.append(title, pill); button.append(top, meta)
    if (!swipeActions) {
      button.addEventListener('click', () => void openSession(item))
      return button
    }
    const wrapper = document.createElement('div'); wrapper.className = 'session-swipe'
    const actions = document.createElement('div'); actions.className = 'session-swipe-actions'
    const pin = document.createElement('button'); pin.type = 'button'; pin.className = 'session-action pin'
    pin.textContent = state.pinnedSessionIds.has(item.sessionId) ? '取消置顶' : '置顶'
    pin.onclick = event => {
      event.stopPropagation()
      if (state.pinnedSessionIds.has(item.sessionId)) state.pinnedSessionIds.delete(item.sessionId)
      else state.pinnedSessionIds.add(item.sessionId)
      savePinnedSessions(); renderTasks()
    }
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'session-action delete'; remove.textContent = '删除'
    remove.onclick = event => { event.stopPropagation(); void archiveSession(item) }
    actions.append(pin, remove); wrapper.append(actions, button)
    let startX = 0; let lastX = 0; let dragging = false
    button.addEventListener('pointerdown', event => { startX = lastX = event.clientX; dragging = false; button.setPointerCapture?.(event.pointerId) })
    button.addEventListener('pointermove', event => {
      if (!button.hasPointerCapture?.(event.pointerId)) return
      lastX = event.clientX
      const distance = Math.min(0, Math.max(-132, lastX - startX))
      if (Math.abs(distance) > 8) dragging = true
      button.style.transform = `translateX(${distance}px)`
    })
    button.addEventListener('pointerup', event => {
      if (button.hasPointerCapture?.(event.pointerId)) button.releasePointerCapture(event.pointerId)
      const opened = startX - lastX >= 56
      wrapper.classList.toggle('open', opened)
      button.style.transform = ''
    })
    button.addEventListener('pointercancel', () => {
      button.style.transform = ''
      dragging = false
    })
    button.addEventListener('click', event => {
      if (dragging) { event.preventDefault(); return }
      if (wrapper.classList.contains('open')) {
        event.preventDefault()
        wrapper.classList.remove('open')
        return
      }
      void openSession(item)
    })
    return wrapper
  }

  async function archiveSession(item) {
    if (!confirm(`删除“${sessionTitle(item)}”？\n\n会话只会从列表归档，电脑目录和历史记录不会被删除。`)) return
    try {
      const result = await rpc('workspace.archiveSession', { sessionId: item.sessionId })
      state.archivedSessionIds = new Set(result?.archivedSessionIds || [...state.archivedSessionIds, item.sessionId])
      state.pinnedSessionIds.delete(item.sessionId); savePinnedSessions()
      $('taskNotice').textContent = '会话已归档，电脑目录和历史记录均已保留。'
      renderTasks()
    } catch (error) { $('taskNotice').textContent = `删除失败：${error.message}` }
  }

  async function openSession(item) {
    state.currentSession = item
    state.historyEvents = []
    state.promptMode = 'queue'
    state.sessionPageOpen = true
    applyProjectionValues(item?.projections?.values || {}, true, item?.projections?.asOfSeq)
    $('sessionTitle').textContent = sessionTitle(item)
    $('sessionMeta').textContent = item.cwd || item.sessionId
    $('historyList').replaceChildren(messageNode('assistant', '正在加载历史记录'))
    $('sessionPage').hidden = false
    // The full-screen session visually covers the shell. Make the covered
    // controls non-interactive too, so accessibility services cannot reach
    // the hidden primary navigation through the overlay.
    $('app').inert = true
    document.body.classList.add('session-open')
    renderApproval()
    renderQueuePanel()
    resizePromptInput()
    updateComposerLabels()
    void refreshSessionControls()
    await refreshOpenSessionHistory(item.sessionId)
  }

  function mergeHistoryEvents(history, live) {
    const merged = Array.isArray(history) ? [...history] : []
    const known = new Set(merged.map(entry => (entry?.event || entry)?.seq).filter(Number.isInteger))
    for (const entry of live || []) {
      const seq = (entry?.event || entry)?.seq
      if (Number.isInteger(seq) && known.has(seq)) continue
      merged.push(entry)
      if (Number.isInteger(seq)) known.add(seq)
    }
    merged.sort((left, right) => {
      const leftSeq = (left?.event || left)?.seq
      const rightSeq = (right?.event || right)?.seq
      return Number.isInteger(leftSeq) && Number.isInteger(rightSeq) ? leftSeq - rightSeq : 0
    })
    return merged
  }

  async function refreshOpenSessionHistory(sessionId, showError = true) {
    const historySeq = ++state.sessionHistorySeq
    const historyIsCurrent = () => historySeq === state.sessionHistorySeq
      && state.sessionPageOpen && state.currentSession?.sessionId === sessionId
    try {
      const history = await rpc('session.history', { sessionId, maxMessages: 40 })
      if (!historyIsCurrent()) return
      state.historyEvents = mergeHistoryEvents(history?.events || [], state.historyEvents)
      state.permissions = history?.projections?.values?.permissions || null
      applyProjectionValues(history?.projections?.values || {}, false, history?.projections?.asOfSeq)
      updateComposerLabels()
      renderHistory(state.historyEvents)
    } catch (error) {
      if (showError && historyIsCurrent()) $('historyList').replaceChildren(messageNode('assistant', error.message))
    }
  }

  function closeSessionPage() {
    closeSheet()
    state.contextMeterOpen = false
    renderContextMeter()
    state.sessionPageOpen = false
    $('sessionPage').hidden = true
    $('app').inert = false
    document.body.classList.remove('session-open')
    renderApproval()
  }

  function formatContextTokens(value) {
    if (!Number.isFinite(value) || value < 0) return '0'
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M`
    if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1).replace(/\.0$/, '')}K`
    return String(Math.round(value))
  }

  function applyProjectionValues(values, reset = false, seq) {
    if (reset) {
      state.contextPressure = null
      state.contextBreakdown = null
      state.contextMeterOpen = false
      state.projectionSeqs.clear()
    }
    const incomingSeq = Number.isInteger(seq) ? seq : -1
    const apply = (key, assign) => {
      if (!values || !Object.prototype.hasOwnProperty.call(values, key)) return
      const previous = state.projectionSeqs.get(key)
      if (previous !== undefined && incomingSeq < previous) return
      state.projectionSeqs.set(key, incomingSeq)
      assign(values[key])
    }
    apply('contextPressure', value => { state.contextPressure = value })
    apply('contextBreakdown', value => { state.contextBreakdown = value })
    renderContextMeter()
  }

  function renderContextMeter() {
    const pressure = state.contextPressure || {}
    const usedTokens = pressure.projectedTokens ?? pressure.pressureTokens
    const contextWindow = pressure.contextWindow
    const available = Number.isFinite(usedTokens) && usedTokens >= 0 && Number.isFinite(contextWindow) && contextWindow > 0
    const button = $('contextMeterButton')
    if (!button) return
    button.hidden = !available
    if (!available) {
      state.contextMeterOpen = false
      $('contextMeterPanel').hidden = true
      button.setAttribute('aria-expanded', 'false')
      return
    }
    const percent = Math.min(100, Math.round(usedTokens / contextWindow * 100))
    button.setAttribute('aria-label', `上下文已用 ${percent}%`)
    button.setAttribute('aria-expanded', String(state.contextMeterOpen))
    $('contextRingFill').style.strokeDasharray = `${percent} 100`
    $('contextPercent').textContent = `${percent}%`
    $('contextFigures').textContent = `~${formatContextTokens(usedTokens)} / ${formatContextTokens(contextWindow)}`
    $('contextMeterPanel').hidden = !state.contextMeterOpen

    const breakdown = state.contextBreakdown
    const values = [breakdown?.systemTokens, breakdown?.toolsTokens, breakdown?.messageTokens]
      .map(value => Number.isFinite(value) && value >= 0 ? value : 0)
    $('contextRows').hidden = !breakdown
    $('contextSystem').textContent = `~${formatContextTokens(values[0])}`
    $('contextTools').textContent = `~${formatContextTokens(values[1])}`
    $('contextMessages').textContent = `~${formatContextTokens(values[2])}`
    const total = values.reduce((sum, value) => sum + value, 0)
    const bar = $('contextBar'); bar.replaceChildren()
    const segments = total > 0
      ? values.map((value, index) => ({ width: percent * value / total, kind: ['system', 'tools', 'messages'][index] }))
      : [{ width: percent, kind: 'total' }]
    for (const segment of segments) {
      if (segment.width <= 0) continue
      const node = document.createElement('i'); node.className = `context-meter-segment ${segment.kind}`
      node.style.width = `${segment.width}%`
      bar.appendChild(node)
    }
  }

  function renderHistory(entries) {
    const list = $('historyList'); list.replaceChildren()
    const rows = foldMessages(entries)
    if (!rows.length) list.appendChild(statusNode('还没有可显示的消息。'))
    for (const row of rows) list.appendChild(conversationNode(row))
    list.scrollTop = list.scrollHeight
  }

  function foldMessages(entries) {
    const events = entries.map(entry => entry?.event || entry).filter(Boolean)
      .sort((a, b) => (a.seq || 0) - (b.seq || 0))
    const rows = []
    const byId = new Map()
    const pending = new Map()
    const toolsByCall = new Map()
    const toolsByStep = new Map()
    const keyOf = event => `${event?.data?.turn ?? event?.turn ?? ''}.${event?.data?.step ?? event?.step ?? ''}`
    for (const event of events) {
      const data = event?.data || {}
      if (event.type === 'user/message') {
        const text = contentText(data.content)
        const contextSummary = internalContextSummary(text)
        const row = contextSummary
          ? { kind: 'context', text: contextSummary, id: data.id || `context-${event.seq}` }
          : { kind: 'user', text, id: data.id || `user-${event.seq}` }
        rows.push(row); byId.set(row.id, row)
      } else if (event.type === 'context/injection') {
        rows.push({ kind: 'context', text: data.summary || '已应用会话上下文', id: `context-${event.seq}` })
      } else if (event.type === 'assistant/chunk' || event.type === 'message/chunk') {
        const chunk = data.chunk || data
        if (chunk.type && chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta') continue
        if (chunk.type === 'reasoning-delta' || data.kind === 'reasoning') continue
        const key = keyOf(event)
        let row = pending.get(key)
        if (!row) {
          row = { kind: 'assistant', text: '', id: `assistant-${key}-${event.seq}`, pending: true }
          rows.push(row); pending.set(key, row)
        }
        row.text += chunk.text || ''
      } else if (event.type === 'assistant/message') {
        const message = data.message || data
        const id = message.id || data.id || `assistant-${event.seq}`
        const key = keyOf(event)
        const finalText = contentText(message.content)
        const row = byId.get(id) || pending.get(key)
        if (row) {
          row.text = finalText || row.text
          row.pending = false
          byId.set(id, row); pending.delete(key)
        } else {
          const created = { kind: 'assistant', text: finalText, id }
          rows.push(created); byId.set(id, created)
        }
        for (const tool of toolsByStep.get(key) || []) tool.status = 'done'
        // Some providers finalize on a different step coordinate. A final
        // assistant message still closes every earlier call in this turn.
        for (const tool of rows.filter(item => item.kind === 'tool' && item.turn === data.turn && item.status === 'running')) tool.status = 'done'
      } else if (event.type === 'tool/call') {
        const key = keyOf(event)
        const callId = String(data.callId || `tool-${event.seq}`)
        if (toolsByCall.has(callId)) continue
        const tool = { kind: 'tool', name: data.name || 'tool', id: callId, status: 'running', turn: data.turn }
        toolsByCall.set(callId, tool)
        toolsByStep.set(key, [...(toolsByStep.get(key) || []), tool])
        rows.push(tool)
      } else if (event.type === 'tool/result') {
        const message = data.message || {}
        const callId = String(data.callId || message.source?.callId || '')
        const tool = toolsByCall.get(callId)
        if (tool) tool.status = data.isError === true || message.content?.some?.(item => item?.isError === true) || data.error ? 'error' : 'done'
      } else if (event.type === 'turn/end') {
        const failed = data.reason?.kind === 'error'
        for (const tool of rows.filter(row => row.kind === 'tool' && row.turn === data.turn)) tool.status = failed ? 'error' : 'done'
        if (failed) rows.push({ kind: 'error', text: '本轮执行失败', detail: '可返回桌面端查看完整错误信息。', id: `error-${event.seq}` })
      }
    }
    return rows.filter(row => row.kind === 'tool' || row.kind === 'error' || row.text)
  }

  function contentText(content) {
    return Array.isArray(content) ? content.filter(block => block?.type === 'text').map(block => block.text || '').join('') : ''
  }

  function internalContextSummary(text) {
    const trimmed = String(text || '').trimStart()
    if (trimmed.startsWith('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.')) return '已应用运行上下文'
    if (trimmed.startsWith('<system-reminder>')) return /workspace instructions|Instructions from:/i.test(trimmed) ? '已应用工作区说明' : '已应用会话上下文'
    return null
  }

  function conversationNode(row) {
    if (row.kind === 'tool') return toolNode(row)
    if (row.kind === 'error') return errorNode(row)
    if (row.kind === 'context') return contextNode(row)
    return messageNode(row.kind, row.text, row.pending === true, row.kind === 'assistant')
  }

  function messageNode(role, text, pending = false, copyable = false) {
    const node = document.createElement('article'); node.className = `message ${role}${pending ? ' pending' : ''}`
    const body = document.createElement('div'); body.className = 'message-body'
    if (role === 'assistant' && window.DshMarkdown) {
      body.innerHTML = window.DshMarkdown.renderMarkdown(text)
      decorateCodeBlocks(body)
    }
    else body.textContent = text
    node.appendChild(body)
    if (pending) {
      const status = document.createElement('small'); status.className = 'message-state'; status.textContent = '正在回复'
      node.appendChild(status)
    }
    if (role === 'assistant' && text.length > 1600) {
      body.classList.add('collapsed')
      const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'message-toggle'; toggle.textContent = `展开全文（${text.length} 字）`
      toggle.onclick = () => {
        const collapsed = body.classList.toggle('collapsed')
        toggle.textContent = collapsed ? `展开全文（${text.length} 字）` : '收起全文'
      }
      node.appendChild(toggle)
    }
    if (copyable && !pending && text.trim()) node.appendChild(messageCopyAction(text))
    return node
  }

  function messageCopyAction(text) {
    const actions = document.createElement('div'); actions.className = 'message-actions'
    const button = document.createElement('button'); button.type = 'button'; button.className = 'message-copy'
    button.setAttribute('aria-label', '复制模型回复')
    button.title = '复制'
    button.innerHTML = '<svg class="message-copy-icon" viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="3" width="9" height="11" rx="2"></rect><path d="M13 14v1a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h1"></path></svg><svg class="message-copy-check" viewBox="0 0 20 20" aria-hidden="true"><path d="m4.5 10.5 3.2 3.2 7.8-8"></path></svg>'
    const status = document.createElement('span'); status.className = 'message-copy-status'; status.setAttribute('aria-live', 'polite')
    button.onclick = async () => {
      button.disabled = true
      try {
        await copyText(text)
        button.dataset.state = 'copied'
        button.setAttribute('aria-label', '模型回复已复制')
        button.title = '已复制'
        status.textContent = '模型回复已复制'
      } catch (_) {
        button.dataset.state = 'error'
        button.setAttribute('aria-label', '复制模型回复失败')
        button.title = '复制失败'
        status.textContent = '复制模型回复失败'
      } finally {
        button.disabled = false
        setTimeout(() => {
          delete button.dataset.state
          button.setAttribute('aria-label', '复制模型回复')
          button.title = '复制'
          status.textContent = ''
        }, 1200)
      }
    }
    actions.append(button, status)
    return actions
  }

  function decorateCodeBlocks(body) {
    for (const pre of body.querySelectorAll('pre')) {
      const code = pre.querySelector('code')
      if (!code || pre.parentElement?.classList.contains('code-block')) continue
      const wrapper = document.createElement('section'); wrapper.className = 'code-block'
      const toolbar = document.createElement('div'); toolbar.className = 'code-toolbar'
      const language = document.createElement('span')
      language.textContent = [...pre.classList].find(name => name.startsWith('language-'))?.slice(9) || '代码'
      const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'code-copy'; copy.textContent = '复制'
      copy.onclick = async () => {
        try {
          await copyText(code.textContent || '')
          copy.textContent = '已复制'
          setTimeout(() => { copy.textContent = '复制' }, 1200)
        } catch (_) { copy.textContent = '复制失败' }
      }
      toolbar.append(language, copy)
      pre.replaceWith(wrapper); wrapper.append(toolbar, pre)
    }
  }

  async function copyText(value) {
    if (window.DshRemoteNative?.copyText) {
      if (window.DshRemoteNative.copyText(value)) return
      throw new Error('native copy unavailable')
    }
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value)
    const field = document.createElement('textarea'); field.value = value; field.setAttribute('readonly', '')
    field.style.position = 'fixed'; field.style.opacity = '0'; document.body.appendChild(field); field.select()
    const copied = document.execCommand('copy'); field.remove()
    if (!copied) throw new Error('copy unavailable')
  }

  function toolNode(row) {
    const node = document.createElement('div'); node.className = 'agent-row tool-row'; node.dataset.state = row.status
    const title = document.createElement('span'); title.className = 'agent-row-title'; title.textContent = row.name
    const summary = document.createElement('span'); summary.className = 'agent-row-summary'
    summary.textContent = row.status === 'error' ? '执行失败' : row.status === 'done' ? '已完成' : '正在执行'
    node.append(title, summary)
    return node
  }

  function errorNode(row) {
    const node = document.createElement('div'); node.className = 'agent-row error-row'
    const title = document.createElement('strong'); title.textContent = row.text
    const detail = document.createElement('span'); detail.textContent = row.detail || ''
    node.append(title, detail)
    return node
  }

  function contextNode(row) {
    const node = document.createElement('div'); node.className = 'agent-row context-row'
    const title = document.createElement('span'); title.className = 'agent-row-title'; title.textContent = '上下文'
    const summary = document.createElement('span'); summary.className = 'agent-row-summary'; summary.textContent = row.text
    node.append(title, summary)
    return node
  }

  function statusNode(text) {
    const node = document.createElement('p'); node.className = 'history-status'; node.textContent = text
    return node
  }

  function currentWorkspace() {
    const sessionId = state.currentSession?.sessionId
    return state.workspaces.find(workspace => Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId))
      || state.workspaces.find(workspace => workspace.path === state.currentSession?.cwd)
  }

  function compactPermissionLabel(value) {
    return {
      'danger-full-access': '全权限',
      'workspace-write': '可写',
      'read-only': '只读',
    }[value] || '权限'
  }

  function compactModelLabel(value) {
    const normalized = String(value || '')
      .replace(/^DeepSeek[-\s_]*/i, '')
      .replace(/[-_]+/g, ' ')
      .trim()
    if (!normalized) return '模型'
    return normalized.length > 12 ? `${normalized.slice(0, 11)}…` : normalized
  }

  function updateComposerLabels() {
    const workspace = currentWorkspace()
    $('workspaceButton').textContent = workspace?.title || state.currentSession?.cwd || '工作目录'
    const currentPreset = state.currentSession?.agentPreset
    const preset = state.presets.find(item => item.id === currentPreset)
    $('presetButton').textContent = preset?.name || currentPreset || 'Agent 模式'
    const permission = state.permissions?.currentValue
    $('permissionButton').textContent = compactPermissionLabel(permission)
    $('permissionButton').title = permission || '权限'
    $('permissionButton').setAttribute('aria-label', permission ? `权限：${permission}` : '选择权限')
    $('pluginsButton').hidden = !state.capabilities.has('git.workbench') && !state.capabilities.has('ssh.list')
    const current = state.models?.current
    if (current) {
      const group = state.models.groups?.find(item => item.id === current.provider)
      const model = group?.models?.find(item => item.id === current.model)
      const modelLabel = model?.name || current.model
      $('modelButton').textContent = compactModelLabel(modelLabel)
      $('modelButton').title = modelLabel
      $('modelButton').setAttribute('aria-label', `模型：${modelLabel}`)
    } else {
      $('modelButton').textContent = '模型'
      $('modelButton').title = '模型'
      $('modelButton').setAttribute('aria-label', '选择模型')
    }
    updateComposerState()
  }

  function updateComposerState() {
    if (!$('sendModeButton')) return
    const running = state.currentSession?.running === true
    const steer = state.promptMode === 'steer'
    $('sendModeButton').textContent = steer ? '引导' : '排队'
    $('sendModeButton').title = steer ? '将消息加入当前运行轮次' : '将消息排在当前轮次之后'
    $('sendModeButton').classList.toggle('active', steer)
    $('cancelSession').disabled = !running
    $('composerStatus').textContent = running
      ? steer ? '正在运行 · 新消息将引导当前轮次' : '正在运行 · 新消息会排在当前轮次之后'
      : steer ? '当前空闲 · 引导会自动开始新一轮' : '当前空闲 · 新消息会开始下一轮'
  }

  function setSessionRunning(running) {
    if (!state.currentSession) return
    state.currentSession.running = running
    const listed = state.sessions.find(item => item.sessionId === state.currentSession.sessionId)
    if (listed) listed.running = running
    updateComposerState()
  }

  async function refreshSessionControls() {
    const sessionId = state.currentSession?.sessionId
    if (!sessionId) return
    const calls = []
    if (state.capabilities.has('session.models')) calls.push(rpc('session.models', { sessionId }).then(value => { state.models = value }))
    if (state.capabilities.has('agentPreset.list')) calls.push(rpc('agentPreset.list', {}).then(value => { state.presets = value?.presets || [] }))
    if (state.capabilities.has('skill.list')) calls.push(rpc('skill.list', { sessionId }).then(value => { state.skills = value?.skills || [] }))
    await Promise.allSettled(calls)
    if (state.currentSession?.sessionId === sessionId) updateComposerLabels()
  }

  function showSheet(title, hint, options) {
    $('sheetTitle').textContent = title
    $('sheetHint').textContent = hint || ''
    const list = $('sheetList'); list.replaceChildren()
    if (!options.length) {
      const empty = document.createElement('p'); empty.className = 'hint'; empty.textContent = '当前没有可用选项。'; list.appendChild(empty)
    }
    for (const option of options) {
      const button = document.createElement('button'); button.type = 'button'; button.className = `sheet-option${option.current ? ' current' : ''}`
      const name = document.createElement('strong'); name.textContent = option.title
      const detail = document.createElement('small'); detail.textContent = option.detail || ''
      button.append(name, detail)
      button.onclick = async () => {
        try {
          await option.select()
          closeSheet()
        } catch (error) { $('sheetHint').textContent = error.message }
      }
      list.appendChild(button)
    }
    $('controlSheet').hidden = false
  }

  function closeSheet() { $('controlSheet').hidden = true }

  function showWorkspaceSheet(createNew = false) {
    const current = currentWorkspace()
    const sessionOptions = createNew ? {} : { agentPreset: state.currentSession?.agentPreset }
    const options = state.workspaces.map(workspace => ({
      title: workspace.title || workspace.path || '工作区',
      detail: workspace.path || '',
      current: !createNew && workspace.workspaceId === current?.workspaceId,
      select: async () => {
        if (!createNew && workspace.workspaceId === current?.workspaceId) return
        await createSessionInWorkspace(workspace, sessionOptions)
      },
    }))
    if (state.capabilities.has('host.listDirectory') && state.capabilities.has('workspace.create')) {
      options.push({
        title: '浏览电脑目录', detail: '打开电脑端目录树，选择新的工作目录', current: false,
        select: async () => { closeSheet(); await openDirectoryBrowser(createNew ? undefined : current?.path, sessionOptions) },
      })
    }
    showSheet(createNew ? '选择新会话的工作目录' : '工作目录', createNew ? '可选择现有工作区，或浏览电脑上的其他目录。' : '切换目录会创建一个新会话，现有会话不会被改写。', options)
  }

  function startNewSessionFlow() {
    $('taskNotice').textContent = ''
    showWorkspaceSheet(true)
  }

  async function createSessionInWorkspace(workspace, options = {}) {
    const created = await rpc('session.create', {
      workspaceId: workspace.workspaceId,
      ...(options.agentPreset ? { agentPreset: options.agentPreset } : {}),
    })
    if (!state.workspaces.some(item => item.workspaceId === workspace.workspaceId)) state.workspaces.push(workspace)
    if (!workspace.sessionIds.includes(created.sessionId)) workspace.sessionIds.unshift(created.sessionId)
    const item = {
      sessionId: created.sessionId, agentPreset: created.agentPreset, cwd: workspace.path,
      blank: true, running: false, updatedAt: Date.now(),
    }
    state.sessions.unshift(item); renderTasks(); fillWorkspaceSelect()
    // The session page renders synchronously; history loading must not keep the picker above it.
    void openSession(item)
  }

  async function openDirectoryBrowser(path, sessionOptions = {}) {
    $('directoryBrowser').hidden = false
    state.directorySessionOptions = sessionOptions
    state.directoryListing = null
    $('directorySearch').value = ''
    $('directoryPath').textContent = ''
    $('directoryCrumbs').replaceChildren()
    $('directoryList').replaceChildren()
    $('directoryNotice').textContent = '正在读取电脑目录'
    const initialPath = path || state.workspaces[0]?.path
    await Promise.allSettled([loadDriveRoots(), loadDirectory(initialPath)])
  }

  function closeDirectoryBrowser() {
    $('directoryBrowser').hidden = true
    state.directoryListing = null
    state.directorySessionOptions = {}
    if (state.directorySearchTimer) clearTimeout(state.directorySearchTimer)
    state.directorySearchTimer = null
    state.directorySearchSeq += 1
    $('directorySearch').value = ''
  }

  function driveRootOf(path) {
    const match = typeof path === 'string' ? /^([A-Za-z]:)[\\/]/.exec(path) : null
    return match ? `${match[1]}\\` : path?.startsWith('/') ? '/' : ''
  }

  async function loadDriveRoots() {
    let roots = []
    if (state.capabilities.has('host.listDrives')) {
      try { roots = (await rpc('host.listDrives'))?.roots || [] } catch (_) {}
    }
    if (!roots.length) {
      roots = [...new Set(state.workspaces.map(workspace => driveRootOf(workspace.path)).filter(Boolean))]
    }
    state.directoryDrives = roots
    renderDriveRoots()
  }

  function renderDriveRoots() {
    const currentRoot = driveRootOf(state.directoryListing?.path)
    const drives = $('directoryDrives'); drives.replaceChildren()
    for (const root of state.directoryDrives) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = root
      button.classList.toggle('current', root.toLocaleLowerCase() === currentRoot.toLocaleLowerCase())
      button.onclick = () => void loadDirectory(root)
      drives.appendChild(button)
    }
  }

  function renderDirectoryRows(entries, emptyText = '此目录没有可显示的子目录。') {
    const list = $('directoryList'); list.replaceChildren()
    const directories = entries.filter(entry => entry && entry.hidden !== true && (
      entry.isDirectory === true || entry.type === 'directory' || entry.type === 'dir' || entry.kind === 'directory' ||
      (entry.isDirectory === undefined && entry.type === undefined && entry.kind === undefined)
    ))
    if (!directories.length) {
      const empty = document.createElement('p'); empty.className = 'queue-empty'; empty.textContent = emptyText; list.appendChild(empty)
    }
    for (const entry of directories) {
      if (!entry || typeof entry.path !== 'string' || typeof entry.name !== 'string') continue
      const button = document.createElement('button'); button.type = 'button'; button.className = 'directory-row'
      const name = document.createElement('strong'); name.textContent = entry.name
      const detail = document.createElement('small'); detail.textContent = entry.path
      button.append(name, detail); button.onclick = () => void loadDirectory(entry.path); list.appendChild(button)
    }
  }

  async function loadDirectory(path) {
    if (state.directoryBusy) return
    state.directoryBusy = true
    state.directorySearchSeq += 1
    $('directoryNotice').textContent = '正在读取电脑目录'
    $('directoryList').replaceChildren()
    try {
      const listing = await rpc('host.listDirectory', path ? { path } : {})
      state.directoryListing = listing
      $('directoryPath').textContent = listing.path
      $('directorySearch').value = ''
      renderDriveRoots()
      const crumbs = $('directoryCrumbs'); crumbs.replaceChildren()
      for (const crumb of listing.crumbs || []) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = crumb.name || crumb.path
        button.onclick = () => void loadDirectory(crumb.path)
        crumbs.appendChild(button)
      }
      renderDirectoryRows(listing.entries || [])
      $('directoryNotice').textContent = listing.truncated ? '此层目录数量较多，仅显示电脑端返回的前一部分。' : ''
    } catch (error) {
      state.directoryListing = null
      $('directoryNotice').textContent = `目录读取失败：${error.message}`
    } finally { state.directoryBusy = false }
  }

  async function searchCurrentDirectory(query) {
    if (!state.directoryListing) return
    const requestSeq = ++state.directorySearchSeq
    const normalized = query.trim()
    if (!normalized) {
      renderDirectoryRows(state.directoryListing.entries || [])
      $('directoryNotice').textContent = state.directoryListing.truncated ? '此层目录数量较多，仅显示电脑端返回的前一部分。' : ''
      return
    }
    if (!state.capabilities.has('host.searchDirectories')) {
      $('directoryNotice').textContent = '电脑端插件版本不支持文件夹搜索，请更新后重试。'
      return
    }
    const root = state.directoryListing.path
    $('directoryNotice').textContent = '正在当前目录下搜索文件夹'
    try {
      const result = await rpc('host.searchDirectories', { path: state.directoryListing.path, query: normalized })
      if (requestSeq !== state.directorySearchSeq || state.directoryListing?.path !== root || $('directorySearch').value.trim() !== normalized) return
      renderDirectoryRows(result.directories || [], '当前目录下没有匹配的文件夹。')
      $('directoryNotice').textContent = result.truncated
        ? `已检查 ${result.scanned || 0} 个文件夹，结果达到安全上限，请缩小关键词。`
        : `在当前目录下找到 ${(result.directories || []).length} 个文件夹。`
    } catch (error) {
      if (requestSeq === state.directorySearchSeq) $('directoryNotice').textContent = `文件夹搜索失败：${error.message}`
    }
  }

  async function chooseCurrentDirectory() {
    const listing = state.directoryListing
    if (!listing || state.directoryBusy) return
    state.directoryBusy = true
    $('directoryNotice').textContent = '正在创建工作区和新会话'
    try {
      const result = await rpc('workspace.create', { path: listing.path })
      await createSessionInWorkspace(result.workspace, state.directorySessionOptions)
      closeDirectoryBrowser()
    } catch (error) { $('directoryNotice').textContent = `创建会话失败：${error.message}` }
    finally { state.directoryBusy = false }
  }

  function showPresetSheet() {
    const current = state.currentSession?.agentPreset
    showSheet('Agent 模式', '已开始对话的会话会锁定模式；可在新会话中切换。', state.presets.filter(item => !item.broken).map(preset => ({
      title: preset.name || preset.id,
      detail: preset.description || `${preset.trust} preset`,
      current: preset.id === current,
      select: async () => {
        if (!state.currentSession || preset.id === current) return
        const selected = await rpc('agentPreset.select', { sessionId: state.currentSession.sessionId, agentPreset: preset.id })
        state.currentSession.agentPreset = selected.agentPreset
        updateComposerLabels()
      },
    })))
  }

  function showPermissionSheet() {
    const permissions = state.permissions
    const options = Array.isArray(permissions?.options) ? permissions.options : []
    showSheet('权限', '沿用 DeepSeek 官方 permission preset，通过当前会话命令切换。', options.map(option => ({
      title: option.name || option.value,
      detail: option.value,
      current: option.value === permissions.currentValue,
      select: async () => {
        if (!state.currentSession || option.value === permissions.currentValue) return
        await rpc('session.prompt', { sessionId: state.currentSession.sessionId, mode: 'queue', content: [{ type: 'text', text: `/permission ${option.value}` }] })
        state.permissions = { ...permissions, currentValue: option.value }
        updateComposerLabels()
      },
    })))
  }

  function sectionTitle(label) {
    const title = document.createElement('div')
    title.className = 'sheet-section-title'
    title.textContent = label
    return title
  }

  function showModelSheet() {
    const choices = []
    for (const group of state.models?.groups || []) {
      for (const model of group.models || []) choices.push({ group, model })
    }
    if (!choices.length) {
      showSheet('模型与思考等级', '模型目录由电脑端 DeepSeek 提供。', [])
      return
    }

    const current = state.models?.current || {}
    const initial = choices.find(choice => choice.group.id === current.provider && choice.model.id === current.model) || choices[0]
    let pending = {
      provider: initial.group.id,
      model: initial.model.id,
      ...((current.provider === initial.group.id && current.model === initial.model.id && current.reasoningEffort)
        ? { reasoningEffort: current.reasoningEffort }
        : (initial.model.reasoning?.defaultEffort ? { reasoningEffort: initial.model.reasoning.defaultEffort } : {})),
    }
    let busy = false

    const render = () => {
      $('sheetTitle').textContent = '模型与思考等级'
      $('sheetHint').textContent = '先选择基础模型，再选择该模型支持的思考等级。'
      const list = $('sheetList'); list.replaceChildren()
      list.appendChild(sectionTitle('模型'))

      for (const choice of choices) {
        const selected = choice.group.id === pending.provider && choice.model.id === pending.model
        const button = document.createElement('button'); button.type = 'button'; button.className = `sheet-option${selected ? ' current' : ''}`
        const name = document.createElement('strong'); name.textContent = choice.model.name || choice.model.id
        const detail = document.createElement('small'); detail.textContent = choice.model.description || choice.group.name || choice.group.id
        button.append(name, detail)
        button.disabled = busy
        button.onclick = () => {
          pending = {
            provider: choice.group.id,
            model: choice.model.id,
            ...(choice.model.reasoning?.defaultEffort ? { reasoningEffort: choice.model.reasoning.defaultEffort } : {}),
          }
          render()
        }
        list.appendChild(button)
      }

      const selectedChoice = choices.find(choice => choice.group.id === pending.provider && choice.model.id === pending.model)
      const reasoning = selectedChoice?.model.reasoning
      const efforts = reasoning?.efforts || []
      if (efforts.length) {
        list.appendChild(sectionTitle('思考等级'))
        const effortChoices = reasoning.defaultEffort === undefined
          ? [{ id: undefined, name: '跟随模型默认', description: '使用电脑端模型的默认思考等级。' }, ...efforts]
          : efforts
        const effectiveEffort = pending.reasoningEffort ?? reasoning.defaultEffort
        for (const effort of effortChoices) {
          const button = document.createElement('button'); button.type = 'button'; button.className = `sheet-option${effectiveEffort === effort.id ? ' current' : ''}`
          const name = document.createElement('strong'); name.textContent = effort.name || effort.id
          const detail = document.createElement('small'); detail.textContent = effort.description || ''
          button.append(name, detail)
          button.disabled = busy
          button.onclick = () => {
            const next = { provider: pending.provider, model: pending.model }
            if (effort.id !== undefined) next.reasoningEffort = effort.id
            pending = next
            render()
          }
          list.appendChild(button)
        }
      }

      const applyButton = document.createElement('button'); applyButton.type = 'button'; applyButton.className = 'action primary sheet-apply'
      applyButton.textContent = busy ? '正在应用…' : '应用选择'
      applyButton.disabled = busy
      applyButton.onclick = async () => {
        if (!state.currentSession || busy) return
        busy = true; render()
        try {
          const selection = { provider: pending.provider, model: pending.model, ...(pending.reasoningEffort ? { reasoningEffort: pending.reasoningEffort } : {}) }
          const result = await rpc('session.selectModel', { sessionId: state.currentSession.sessionId, ...selection })
          state.models.current = result?.selected || selection
          updateComposerLabels()
          closeSheet()
        } catch (error) {
          busy = false; render(); $('sheetHint').textContent = error.message
        }
      }
      list.appendChild(applyButton)
      $('controlSheet').hidden = false
    }
    render()
  }

  function showSendModeSheet() {
    showSheet('发送方式', '排队会等待当前轮次；引导会把消息交给正在运行的当前轮次。空闲时引导会按官方行为开始新一轮。', [
      {
        title: '排队',
        detail: '当前轮次结束后再处理这条消息。',
        current: state.promptMode === 'queue',
        select: async () => { state.promptMode = 'queue'; updateComposerState() },
      },
      {
        title: '引导',
        detail: '把这条消息加入当前轮次；空闲时自动开始新一轮。',
        current: state.promptMode === 'steer',
        select: async () => { state.promptMode = 'steer'; updateComposerState() },
      },
    ])
  }

  function showSkillsSheet() {
    showSheet('Skills', '选择后会把官方 /skill 命令插入输入框，由 Host 在执行前加载。', state.skills.map(skill => ({
      title: `/${skill.name}`,
      detail: skill.description || skill.whenToUse || '',
      select: async () => {
        setPromptInput(`/${skill.name} ${$('promptInput').value}`)
        $('promptInput').focus()
      },
    })))
  }

  function showPluginsSheet() {
    const options = []
    if (state.capabilities.has('git.workbench')) options.push({
      title: 'Git 工作台', detail: '让 DeepSeek 调用 Git 插件；写操作仍受 approval 约束。',
      select: async () => { setPromptInput(`请使用 Git 工作台：${$('promptInput').value}`); $('promptInput').focus() },
    })
    if (state.capabilities.has('ssh.list')) options.push({
      title: 'SSH 插件', detail: '让 DeepSeek 调用 SSH 工具；真实执行必须请求一次性 approval。',
      select: async () => { setPromptInput(`请使用 SSH 插件：${$('promptInput').value}`); $('promptInput').focus() },
    })
    showSheet('插件调用', '这里只生成受控会话指令，不开放任意远程工具 RPC。', options)
  }

  function readAttachment(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(new Error('附件读取失败'))
      reader.onload = () => {
        const value = typeof reader.result === 'string' ? reader.result : ''
        const separator = value.indexOf(',')
        if (separator < 0) reject(new Error('附件格式无效'))
        else resolve({ name: file.name, mediaType: file.type, data: value.slice(separator + 1), size: file.size })
      }
      reader.readAsDataURL(file)
    })
  }

  async function addAttachments(files) {
    for (const file of files) {
      if (state.attachments.length >= ATTACHMENT_MAX_COUNT) throw new Error(`最多添加 ${ATTACHMENT_MAX_COUNT} 个附件`)
      if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error('仅支持 PNG、JPEG、WebP 和 GIF')
      if (file.size > ATTACHMENT_MAX_BYTES) throw new Error('单个附件不能超过 1 MiB')
      state.attachments.push(await readAttachment(file))
    }
    renderAttachments()
  }

  function renderAttachments() {
    const list = $('attachmentList'); list.replaceChildren(); list.hidden = state.attachments.length === 0
    state.attachments.forEach((attachment, index) => {
      const chip = document.createElement('div'); chip.className = 'attachment-chip'
      const name = document.createElement('span'); name.textContent = attachment.name
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '移除'
      remove.onclick = () => { state.attachments.splice(index, 1); renderAttachments() }
      chip.append(name, remove); list.appendChild(chip)
    })
  }

  function currentQueuedItems() {
    const sessionId = state.currentSession?.sessionId
    return (state.queuesBySession.get(sessionId) || []).filter(item => item?.placement === 'queued')
  }

  function queuedItemText(item) {
    const content = item?.message?.content
    return Array.isArray(content) && content.length === 1 && content[0]?.type === 'text'
      ? String(content[0].text || '')
      : null
  }

  const QUEUE_ICON_PATHS = {
    queue: 'M3 3.5h10v7H7l-3 2v-2H3zM5.5 6h5M5.5 8h3.5',
    edit: 'M3 12.5l.5-3 7.7-7.7a1 1 0 0 1 1.4 0l1.6 1.6a1 1 0 0 1 0 1.4l-7.7 7.7-3 .5ZM9.8 3.2l3 3',
    remove: 'M3 4.5h10M6 4.5V2.8h4v1.7M4.3 4.5l.6 9h6.2l.6-9M6.5 7v4M9.5 7v4',
    up: 'M8 13V3M4.5 6.5 8 3l3.5 3.5',
    down: 'M8 3v10M4.5 9.5 8 13l3.5-3.5',
    steer: 'M3 13 13 3M6 3h7v7',
    save: 'm3.5 8.5 3 3 6-7',
    cancel: 'm4 4 8 8M12 4l-8 8',
  }

  function queueIcon(icon) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 16 16')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('focusable', 'false')
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', QUEUE_ICON_PATHS[icon])
    svg.appendChild(path)
    return svg
  }

  function queueAction(icon, label, handler, disabled = false, title = '') {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'queue-icon-action'
    button.setAttribute('aria-label', label)
    button.title = title || label
    button.disabled = disabled
    button.appendChild(queueIcon(icon))
    button.onclick = event => { event.stopPropagation(); void handler() }
    return button
  }

  function renderQueuePanel() {
    const panel = $('queuePanel'); const list = $('queueList')
    const items = currentQueuedItems()
    panel.hidden = items.length === 0
    if (items.length === 0) state.queueExpanded = false
    const toggle = $('toggleQueue')
    const listVisible = items.length === 1 || state.queueExpanded
    toggle.hidden = items.length <= 1
    toggle.setAttribute('aria-expanded', String(state.queueExpanded))
    toggle.setAttribute('aria-label', state.queueExpanded ? '收起排队消息' : '展开排队消息')
    $('queueCount').textContent = `${items.length} 条排队消息`
    list.hidden = !listVisible
    list.replaceChildren()
    if (!listVisible) return
    items.forEach((item, index) => {
      const row = document.createElement('article'); row.className = 'queue-item'
      const text = queuedItemText(item)
      if (items.length === 1) {
        const lead = document.createElement('span'); lead.className = 'queue-lead'; lead.setAttribute('aria-hidden', 'true')
        lead.appendChild(queueIcon('queue')); row.appendChild(lead)
      }
      const title = document.createElement('span'); title.className = 'queue-item-title'; title.textContent = text ?? '包含附件的排队消息'
      const actions = document.createElement('div'); actions.className = 'queue-item-actions'
      const textOnly = text !== null
      actions.append(
        queueAction('edit', '编辑排队消息', () => beginQueueEdit(row, item, text), state.queueBusy || !textOnly, textOnly ? '' : '包含附件，不能在手机端改写'),
        queueAction('remove', '删除排队消息', () => updateQueuedItem(item.id, { kind: 'remove' }), state.queueBusy),
        queueAction('up', '上移排队消息', () => moveQueuedItem(item.id, -1), state.queueBusy || !textOnly || index === 0),
        queueAction('down', '下移排队消息', () => moveQueuedItem(item.id, 1), state.queueBusy || !textOnly || index === items.length - 1),
        queueAction('steer', '立即引导当前轮次', () => updateQueuedItem(item.id, { kind: 'steer' }), state.queueBusy || state.currentSession?.running !== true, state.currentSession?.running === true ? '' : '仅当前轮次运行中可用'),
      )
      row.append(title, actions); list.appendChild(row)
    })
  }

  function beginQueueEdit(row, item, text) {
    if (text === null || state.queueBusy) return
    const editor = document.createElement('textarea'); editor.className = 'queue-editor'; editor.rows = 3; editor.value = text
    const controls = document.createElement('div'); controls.className = 'queue-edit-actions'
    controls.append(
      queueAction('save', '保存排队消息', async () => {
        const next = editor.value.trim()
        if (!next) { editor.setCustomValidity('排队消息不能为空'); editor.reportValidity(); return }
        await updateQueuedItem(item.id, { kind: 'edit', content: [{ type: 'text', text: next }] })
      }),
      queueAction('cancel', '取消编辑排队消息', () => renderQueuePanel()),
    )
    row.classList.add('editing')
    row.replaceChildren(editor, controls); editor.focus(); editor.setSelectionRange(editor.value.length, editor.value.length)
  }

  async function updateQueuedItem(itemId, action) {
    if (!state.currentSession || state.queueBusy) return
    state.queueBusy = true; renderQueuePanel()
    try {
      await rpc('session.updateQueue', { sessionId: state.currentSession.sessionId, itemId, action })
      $('sessionMeta').textContent = action.kind === 'steer' ? '排队消息已转为引导' : action.kind === 'remove' ? '排队消息已删除' : '排队消息已更新'
    } catch (error) {
      $('sessionMeta').textContent = error.code === 'queue-item-not-found'
        ? '该消息已开始处理，正在同步最新队列'
        : `排队操作失败：${error.message}`
    } finally {
      state.queueBusy = false
      requestEventsBaseline()
      renderQueuePanel()
    }
  }

  async function moveQueuedItem(itemId, direction) {
    if (!state.currentSession || state.queueBusy) return
    const items = currentQueuedItems()
    const index = items.findIndex(item => item.id === itemId)
    const targetIndex = index + direction
    if (index < 0 || targetIndex < 0 || targetIndex >= items.length) return
    const source = items[index]; const target = items[targetIndex]
    const sourceText = queuedItemText(source); const targetText = queuedItemText(target)
    if (sourceText === null || targetText === null) { $('sessionMeta').textContent = '包含附件的消息不能在手机端排序'; return }
    state.queueBusy = true; renderQueuePanel()
    try {
      await rpc('session.updateQueue', { sessionId: state.currentSession.sessionId, itemId: source.id, action: { kind: 'edit', content: target.message.content } })
      try {
        await rpc('session.updateQueue', { sessionId: state.currentSession.sessionId, itemId: target.id, action: { kind: 'edit', content: source.message.content } })
      } catch (error) {
        await rpc('session.updateQueue', { sessionId: state.currentSession.sessionId, itemId: source.id, action: { kind: 'edit', content: source.message.content } }).catch(() => {})
        throw error
      }
      $('sessionMeta').textContent = '排队顺序已更新'
    } catch (error) { $('sessionMeta').textContent = `排序失败，正在同步最新队列：${error.message}` }
    finally {
      state.queueBusy = false
      requestEventsBaseline()
      renderQueuePanel()
    }
  }

  function handleMux(envelope) {
    const frame = envelope?.payload
    if (!frame) return
    if (frame.type === 'session/subscribed') {
      // This is the official mux-generation boundary. The Host omits an empty
      // queue baseline, so retaining the previous value creates phantom work.
      state.queuesBySession.delete(frame.sessionId)
      if (state.currentSession?.sessionId === frame.sessionId) {
        renderQueuePanel()
        if (state.sessionPageOpen) void refreshOpenSessionHistory(frame.sessionId, false)
      }
    } else if (frame.type === 'approval/requested') {
      state.pendingApproval = { rpcId: envelope.rpcId, ...frame, busy: false, error: '' }
      renderApproval()
    } else if (frame.type === 'approval/resolved' && state.pendingApproval?.approvalId === frame.approvalId) {
      state.pendingApproval = null; renderApproval()
    } else if (frame.type === 'question/requested') {
      state.pendingQuestion = { rpcId: envelope.rpcId, ...frame, busy: false, error: '' }
      renderApproval()
    } else if (frame.type === 'question/resolved' && state.pendingQuestion?.rpcId === frame.questionRpcId) {
      state.pendingQuestion = null; renderApproval()
    } else if (frame.type === 'session/event') {
      if (state.currentSession?.sessionId === frame.sessionId && frame.event) {
        if (frame.event.type === 'turn/start') setSessionRunning(true)
        if (frame.event.type === 'turn/end') setSessionRunning(false)
        const seq = frame.event.seq
        if (!state.historyEvents.some(entry => (entry?.event || entry)?.seq === seq)) state.historyEvents.push({ event: frame.event })
        renderHistory(state.historyEvents)
      }
      void refreshWorkspacesAndTasks().catch(() => {})
    } else if (frame.type === 'session/queue') {
      state.queuesBySession.set(frame.sessionId, Array.isArray(frame.items) ? frame.items : [])
      if (state.currentSession?.sessionId === frame.sessionId) renderQueuePanel()
    } else if (frame.type === 'session/projection') {
      if (state.currentSession?.sessionId === frame.sessionId) {
        applyProjectionValues({ [frame.key]: frame.value }, false, frame.seq)
        if (frame.key === 'permissions') {
          state.permissions = frame.value
          updateComposerLabels()
        }
      }
    } else if (frame.type === 'host/archived-sessions-changed') {
      state.archivedSessionIds = new Set(frame.archivedSessionIds || [])
      renderTasks()
    } else if (frame.type === 'session/jobs') {
      void refreshWorkspacesAndTasks().catch(() => {})
    }
  }

  function renderApproval() {
    const interaction = state.pendingQuestion || state.pendingApproval
    const inOpenSession = interaction && state.sessionPageOpen && interaction.sessionId === state.currentSession?.sessionId
    renderApprovalBox($('sessionApproval'), inOpenSession ? interaction : null)
    renderApprovalBox($('approvalBox'), interaction && !inOpenSession ? interaction : null)
    $('sessionPage').querySelector('.composer')?.classList.toggle('awaiting-approval', Boolean(inOpenSession))
  }

  function renderApprovalBox(box, interaction) {
    box.replaceChildren()
    box.removeAttribute('aria-label')
    if (!interaction) { box.className = 'approval hidden'; return }
    box.className = 'approval'
    if (Array.isArray(interaction.questions)) {
      renderQuestionBox(box, interaction)
      return
    }
    renderToolApprovalBox(box, interaction)
  }

  function renderToolApprovalBox(box, approval) {
    const strip = document.createElement('div'); strip.className = 'approval-strip'; strip.textContent = '等待审批'
    const title = document.createElement('strong'); title.textContent = approval.reason || `工具 ${approval.toolName || '未知工具'} 请求越权执行`
    const tool = document.createElement('p'); tool.textContent = `工具：${approval.toolName || '未知工具'}`
    const actions = document.createElement('div'); actions.className = 'approval-actions'
    const reject = document.createElement('button'); reject.className = 'action danger'; reject.textContent = '拒绝'
    const allow = document.createElement('button'); allow.className = 'action primary'; allow.textContent = '允许一次'
    reject.disabled = approval.busy === true
    allow.disabled = approval.busy === true
    reject.onclick = () => void answerApproval('rejected')
    allow.onclick = () => void answerApproval('allowed-once')
    actions.append(reject, allow); box.append(strip, title, tool, interactionError(approval.error), actions)
  }

  function planReviewOf(questions) {
    if (!Array.isArray(questions) || questions.length !== 1) return null
    const question = questions[0]
    const intent = question?.intent
    if (intent?.kind !== 'plan-review' || question.detail === undefined) return null
    if (question.multiSelect === true) return null
    const options = Array.isArray(question.options) ? question.options : []
    if (options.length > 2) return null
    const approve = options.find(option => option?.label === intent.approve)
    if (!approve) return null
    const decline = options.find(option => option?.label !== intent.approve)
    return { id: question.id, question: question.question, plan: question.detail, approve, decline }
  }

  function renderQuestionBox(box, question) {
    const review = planReviewOf(question.questions)
    if (!review) {
      const strip = document.createElement('div'); strip.className = 'approval-strip'; strip.textContent = '需要电脑处理'
      const title = document.createElement('strong'); title.textContent = question.questions?.[0]?.question || 'DeepSeek 正在等待回答'
      const notice = document.createElement('p'); notice.textContent = '此问题暂不支持在 Android 端回答，请在电脑端继续。'
      box.append(strip, title, notice)
      return
    }
    box.setAttribute('aria-label', review.question)
    const strip = document.createElement('div'); strip.className = 'approval-strip'; strip.textContent = '计划待审'
    const body = document.createElement('div'); body.className = 'plan-review-body'
    if (window.DshMarkdown) {
      body.innerHTML = window.DshMarkdown.renderMarkdown(review.plan)
      decorateCodeBlocks(body)
    } else body.textContent = review.plan
    const actions = document.createElement('div'); actions.className = 'approval-actions plan-review-actions'
    const discuss = document.createElement('button'); discuss.className = 'action'; discuss.textContent = '去聊天里说'
    discuss.disabled = question.busy === true
    discuss.onclick = () => void cancelQuestion()
    actions.appendChild(discuss)
    if (review.decline) {
      const reject = document.createElement('button'); reject.className = 'action danger'; reject.textContent = '拒绝'
      reject.disabled = question.busy === true
      if (review.decline.description) reject.title = review.decline.description
      reject.onclick = () => void answerQuestion(review.id, review.decline.label)
      actions.appendChild(reject)
    }
    const approve = document.createElement('button'); approve.className = 'action primary'; approve.textContent = '确认执行'
    approve.disabled = question.busy === true
    if (review.approve.description) approve.title = review.approve.description
    approve.onclick = () => void answerQuestion(review.id, review.approve.label)
    actions.appendChild(approve)
    box.append(strip, body, interactionError(question.error), actions)
  }

  function interactionError(message) {
    const error = document.createElement('p'); error.className = 'approval-error'; error.setAttribute('role', 'status')
    error.textContent = message || ''
    return error
  }

  async function answerApproval(outcome) {
    const approval = state.pendingApproval
    if (!approval || approval.busy) return
    approval.busy = true
    approval.error = ''
    renderApproval()
    try {
      await rpc('events.respond', { result: { ok: true, value: { sessionId: approval.sessionId, approvalId: approval.approvalId, outcome } } }, approval.rpcId)
    } catch (error) {
      if (state.pendingApproval === approval) {
        approval.busy = false
        approval.error = `审批失败：${error.message}`
        renderApproval()
      }
    }
  }

  async function answerQuestion(questionId, label) {
    const question = state.pendingQuestion
    if (!question || question.busy) return
    question.busy = true
    question.error = ''
    renderApproval()
    try {
      await rpc('events.respond', {
        result: { ok: true, value: { sessionId: question.sessionId, answer: { answers: [{ id: questionId, selected: [label] }] } } },
      }, question.rpcId)
    } catch (error) {
      if (state.pendingQuestion === question) {
        question.busy = false
        question.error = `计划操作失败：${error.message}`
        renderApproval()
      }
    }
  }

  async function cancelQuestion() {
    const question = state.pendingQuestion
    if (!question || question.busy) return
    question.busy = true
    question.error = ''
    renderApproval()
    try {
      await rpc('events.respond', {
        result: { ok: false, error: { code: 'cancelled', message: 'the user closed this question request', details: {} } },
      }, question.rpcId)
    } catch (error) {
      if (state.pendingQuestion === question) {
        question.busy = false
        question.error = `计划操作失败：${error.message}`
        renderApproval()
      }
    }
  }

  function fillWorkspaceSelect() {
    const select = $('gitWorkspace'); const previous = select.value; select.replaceChildren()
    for (const workspace of state.workspaces) {
      const option = document.createElement('option')
      option.value = workspace.path || workspace.cwd || ''
      option.textContent = workspace.name || option.value.split(/[\\/]/).filter(Boolean).pop() || '工作区'
      select.appendChild(option)
    }
    if ([...select.options].some(option => option.value === previous)) select.value = previous
  }

  async function refreshGit() {
    if (!state.capabilities.has('git.workbench')) {
      $('gitSummary').textContent = 'Git 插件未提供远程只读服务。'; return
    }
    const path = $('gitWorkspace').value || state.workspaces[0]?.path
    if (!path) return
    try {
      const repo = await rpc('git.workbench', { path })
      const summary = $('gitSummary'); summary.className = 'card compact'; summary.replaceChildren()
      const title = document.createElement('div'); title.className = 'row-title'; title.textContent = repo ? `${repo.branch || 'detached'} · ${repo.upstream || '无 upstream'}` : '不是 Git 仓库'
      summary.appendChild(title)
      if (!repo) return
      const stats = document.createElement('div'); stats.className = 'repo-stats'
      for (const text of [`${repo.changes?.length || 0} 处改动`, `ahead ${repo.ahead || 0}`, `behind ${repo.behind || 0}`]) { const span = document.createElement('span'); span.textContent = text; stats.appendChild(span) }
      summary.appendChild(stats)
      const changes = $('gitChanges'); changes.replaceChildren(); changes.className = 'stack'
      for (const change of repo.changes || []) {
        const row = document.createElement('div'); row.className = 'row-card'
        const name = document.createElement('div'); name.className = 'row-title'; name.textContent = change.path
        const meta = document.createElement('div'); meta.className = 'row-meta'; meta.textContent = `${change.index || ' '} ${change.worktree || ' '}${change.conflicted ? ' · 冲突' : ''}`
        row.append(name, meta); changes.appendChild(row)
      }
    } catch (error) { $('gitSummary').textContent = error.message }
  }

  async function refreshSsh() {
    if (!state.capabilities.has('ssh.list')) { $('sshList').textContent = 'SSH 插件未提供远程只读服务。'; return }
    try {
      const hosts = await rpc('ssh.list', {})
      const list = $('sshList'); list.replaceChildren(); list.className = hosts.length ? 'stack' : 'stack empty'
      if (!hosts.length) { list.textContent = '尚未配置 SSH 主机。'; return }
      for (const host of hosts) {
        const row = document.createElement('div'); row.className = 'row-card'
        const top = document.createElement('div'); top.className = 'row-top'
        const title = document.createElement('span'); title.className = 'row-title'; title.textContent = host.alias
        const ready = document.createElement('span'); ready.className = `pill${host.credentialReady && host.hostKeyPinned ? ' running' : ''}`; ready.textContent = host.credentialReady && host.hostKeyPinned ? '已固定' : '需检查'
        const meta = document.createElement('div'); meta.className = 'row-meta'; meta.textContent = `${host.user}@${host.host}:${host.port} · ${host.auth} · ${host.secretProtection}`
        top.append(title, ready); row.append(top, meta); list.appendChild(row)
      }
    } catch (error) {
      const list = $('sshList'); list.className = 'stack empty'; list.textContent = safeSshError(error)
    }
  }

  function safeSshError(error) {
    const message = String(error?.message || '')
    if (/DPAPI|ProtectedData|Cryptographic|decrypt|解密/i.test(message)) {
      return 'SSH 配置解密失败。请在电脑端打开 SSH 管理面板，重新保存凭据后再刷新。'
    }
    if (/not configured|未配置|no hosts/i.test(message)) return '尚未配置 SSH 主机。请先在电脑端完成配置。'
    return 'SSH 主机列表暂时无法读取。请确认电脑端 SSH 插件在线后重试。'
  }

  async function sendInstruction(text, prefix) {
    const session = state.currentSession || state.sessions.find(item => item.running) || state.sessions[0]
    if (!session) throw new Error('没有可用会话，请先在 DeepSeek 创建会话')
    await rpc('session.prompt', { sessionId: session.sessionId, mode: 'queue', content: [{ type: 'text', text: `${prefix}\n${text}` }] })
  }

  function formatTime(value) {
    if (!value) return '未知时间'
    return new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }

  function bindUi() {
    document.querySelectorAll('.bottom-nav button').forEach(button => button.addEventListener('click', () => {
      document.querySelectorAll('.bottom-nav button').forEach(item => item.classList.toggle('active', item === button))
      document.querySelectorAll('.view').forEach(view => view.classList.toggle('active', view.id === `view-${button.dataset.view}`))
      if (button.dataset.view === 'git') void refreshGit()
      if (button.dataset.view === 'ssh') void refreshSsh()
    }))
    document.querySelectorAll('[data-life]').forEach(button => button.addEventListener('click', () => lifecycle(button.dataset.life)))
    $('settingsButton').onclick = () => openSettings()
    $('scanQrButton').onclick = () => void startQrScanner()
    $('scanCloseButton').onclick = () => { stopQrScanner(); $('scanDialog').close() }
    $('scanImageButton').onclick = () => $('scanImageInput').click()
    $('scanImageInput').onchange = event => {
      const file = event.target.files?.[0]
      event.target.value = ''
      if (file) void scanQrImage(file)
    }
    $('scanDialog').addEventListener('close', stopQrScanner)
    $('refreshSummary').onclick = $('refreshTasks').onclick = () => void refreshWorkspacesAndTasks().catch(error => { $('taskList').textContent = error.message })
    $('refreshGit').onclick = () => void refreshGit()
    $('refreshSsh').onclick = () => void refreshSsh()
    $('gitWorkspace').onchange = () => void refreshGit()
    $('taskSearch').oninput = event => { state.taskQuery = event.target.value || ''; renderTasks() }
    $('closeSession').onclick = () => closeSessionPage()
    $('newSession').onclick = () => startNewSessionFlow()
    $('workspaceButton').onclick = () => showWorkspaceSheet(false)
    $('presetButton').onclick = () => showPresetSheet()
    $('permissionButton').onclick = () => showPermissionSheet()
    $('modelButton').onclick = () => showModelSheet()
    $('contextMeterButton').onclick = () => { state.contextMeterOpen = !state.contextMeterOpen; renderContextMeter() }
    $('skillsButton').onclick = () => showSkillsSheet()
    $('pluginsButton').onclick = () => showPluginsSheet()
    $('sendModeButton').onclick = () => showSendModeSheet()
    $('toggleQueue').onclick = () => { state.queueExpanded = !state.queueExpanded; renderQueuePanel() }
    $('promptInput').oninput = () => resizePromptInput()
    $('closeSheet').onclick = $('sheetBackdrop').onclick = () => closeSheet()
    $('closeDirectory').onclick = $('directoryBackdrop').onclick = () => closeDirectoryBrowser()
    $('refreshDirectory').onclick = () => void loadDirectory(state.directoryListing?.path)
    $('directorySearch').oninput = event => {
      if (state.directorySearchTimer) clearTimeout(state.directorySearchTimer)
      const query = event.target.value || ''
      state.directorySearchTimer = setTimeout(() => { state.directorySearchTimer = null; void searchCurrentDirectory(query) }, 260)
    }
    $('chooseDirectory').onclick = () => void chooseCurrentDirectory()
    $('attachmentButton').onclick = () => $('attachmentInput').click()
    $('attachmentInput').onchange = event => {
      void addAttachments([...event.target.files]).catch(error => { $('sessionMeta').textContent = error.message })
      event.target.value = ''
    }
    $('cancelSession').onclick = () => state.currentSession && void rpc('session.cancel', { sessionId: state.currentSession.sessionId }).catch(error => { $('sessionMeta').textContent = error.message })
    $('sendPrompt').onclick = async () => {
      const text = $('promptInput').value.trim(); if ((!text && !state.attachments.length) || !state.currentSession) return
      const attachments = [...state.attachments]
      const content = [
        ...(text ? [{ type: 'text', text }] : []),
        ...attachments.map(item => ({ type: 'image', mediaType: item.mediaType, data: item.data, name: item.name })),
      ]
      $('sendPrompt').disabled = true
      try {
        const mode = state.promptMode
        await rpc('session.prompt', { sessionId: state.currentSession.sessionId, mode, content })
        $('promptInput').value = ''
        resizePromptInput()
        state.attachments = []
        renderAttachments()
        const summary = [text, ...attachments.map(item => `[附件] ${item.name}`)].filter(Boolean).join('\n')
        $('historyList').appendChild(messageNode('user', summary))
        $('sessionMeta').textContent = mode === 'steer' ? '已发送引导' : '消息已排队'
        $('historyList').scrollTop = $('historyList').scrollHeight
      }
      catch (error) { $('sessionMeta').textContent = error.message }
      finally { $('sendPrompt').disabled = false }
    }
    $('sendGitInstruction').onclick = async () => {
      try { await sendInstruction($('gitInstruction').value.trim(), '请使用 Git 工作台检查当前 workspace，并按以下要求执行。涉及提交或推送前说明范围：'); $('gitInstruction').value = '' }
      catch (error) { $('gitInstruction').value = error.message }
    }
    $('sendSshInstruction').onclick = async () => {
      try { await sendInstruction($('sshInstruction').value.trim(), '请使用 SSH 插件按以下要求操作。真实执行必须请求一次性 approval，禁止绕过：'); $('sshInstruction').value = '' }
      catch (error) { $('sshInstruction').value = error.message }
    }
    $('clearConfig').onclick = () => {
      try { window.DshRemoteNative?.clearConfig() } catch (_) {}
      state.config = {}
      renderBindingStatus()
      connect()
    }
    document.addEventListener('pointerdown', event => {
      if (!state.contextMeterOpen || $('contextMeterRoot').contains(event.target)) return
      state.contextMeterOpen = false
      renderContextMeter()
    })
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !state.contextMeterOpen) return
      state.contextMeterOpen = false
      renderContextMeter()
    })
  }

  function renderBindingStatus() {
    const bound = validConfig(state.config)
    $('bindingStatus').textContent = bound ? `已绑定：${state.config.hostId}` : '尚未绑定桌面端'
    $('bindingStatus').classList.toggle('connected', bound)
    $('scanQrButton').textContent = bound ? '重新扫描桌面端二维码' : '扫描桌面端二维码'
    $('clearConfig').hidden = !bound
  }

  function openSettings() {
    renderBindingStatus()
    $('settingsError').textContent = ''
    $('settingsDialog').showModal()
  }

  state.config = nativeConfig()
  loadLocalSessionPreferences()
  window.DshRemoteBack = () => {
    if (state.contextMeterOpen) { state.contextMeterOpen = false; renderContextMeter(); return true }
    if ($('scanDialog').open) { stopQrScanner(); $('scanDialog').close(); return true }
    if (!$('directoryBrowser').hidden) { closeDirectoryBrowser(); return true }
    if (!$('controlSheet').hidden) { closeSheet(); return true }
    if (state.sessionPageOpen) { closeSessionPage(); return true }
    if ($('settingsDialog').open) { $('settingsDialog').close(); return true }
    return false
  }
  bindUi()
  connect()
})()
