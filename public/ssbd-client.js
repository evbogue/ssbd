import {
  base64ToBuf,
  bufToBase64,
  canonicalizeMessage,
  generateEd25519Keypair,
  importPrivateKey,
  importPublicKey,
  parseTagged,
  toTaggedSig,
  verifyBytes
} from './lib/webcrypto-keys.js'

const feedEl = document.getElementById('ssbd-feed')
const statusEl = document.getElementById('ssbd-status')
const statusContainer = document.getElementById('ssbd-status-bar')
const composeEl = document.getElementById('ssbd-text')
const publishBtn = document.getElementById('ssbd-publish')
const deleteBtn = document.getElementById('ssbd-delete-all')
const feedViewEl = document.getElementById('ssbd-feed-view')
const profileViewEl = document.getElementById('ssbd-profile-view')
const messageViewEl = document.getElementById('ssbd-message-view')
const profileAvatarEl = document.getElementById('ssbd-profile-avatar')
const profileTitleEl = document.getElementById('ssbd-profile-title')
const profileIdEl = document.getElementById('ssbd-profile-id')
const profileSelfNameEl = document.getElementById('ssbd-profile-self-name')
const profileNameLabel = document.getElementById('ssbd-profile-label')
const profileNameInput = document.getElementById('ssbd-profile-name')
const profileSaveBtn = document.getElementById('ssbd-profile-save')
const profileFeedEntries = document.getElementById('ssbd-profile-feed-entries')
const followActionsEl = document.getElementById('ssbd-follow-actions')
const followBtn = document.getElementById('ssbd-follow-btn')
const unfollowBtn = document.getElementById('ssbd-unfollow-btn')
const avatarFileInput = document.getElementById('ssbd-avatar-file')
const avatarUploadBtn = document.getElementById('ssbd-avatar-upload')
const messageTitleEl = document.getElementById('ssbd-message-title')
const messageIdEl = document.getElementById('ssbd-message-id')
const messageMetaEl = document.getElementById('ssbd-message-meta')
const messageBodyEl = document.getElementById('ssbd-message-body')
const messageRawEl = document.getElementById('ssbd-message-raw')
const navFeedLink = document.getElementById('ssbd-nav-feed')
const navProfileLink = document.getElementById('ssbd-nav-profile')
const serverHost = window.SSBD_HOST || window.location.hostname
const serverPort = window.SSBD_PORT || window.location.port || 80
const httpBase = (window.location.protocol || 'http:') + '//' + serverHost + (serverPort ? ':' + serverPort : '')
const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
const wsBase = wsProto + '//' + serverHost + (serverPort ? ':' + serverPort : '')
const feedState = {}
const entryCache = {}
const profileCache = Object.create(null)
const BLOB_HASH_REGEX = /^%[A-Za-z0-9+/=]{42,}\.sha256$/
const avatarUrlCache = new Map()
const avatarFetchPromises = new Map()
const followState = new Map()
const textEncoder = typeof TextEncoder === 'undefined' ? null : new TextEncoder()
const canVerifyCachedEntries = typeof crypto !== 'undefined' && !!crypto.subtle && !!textEncoder

function encodeCanonicalString(value) {
  if (textEncoder) return textEncoder.encode(value)
  return new TextEncoder().encode(value)
}

const hasIndexedDb = typeof indexedDB !== 'undefined'
const DB_NAME = 'ssb-apds'
const DB_VERSION = 1
const ENTRY_STORE = 'entries'
const PENDING_STORE = 'pending'
const MAX_STORED_ENTRIES = 500

let dbPromise = null
let flushInProgress = false
let retryFlushTimer = null

let browserKeys = null
let currentFeedId = null
let currentProfileId = null
let currentMessageKey = null
let signKeyPromise = null
let isInitialOfflineLoad = false
let currentRoute = null
const status = createStatusManager(statusEl)

function openClientDb() {
  if (!hasIndexedDb) return Promise.resolve(null)
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(ENTRY_STORE)) {
          db.createObjectStore(ENTRY_STORE, { keyPath: 'key' })
        }
        if (!db.objectStoreNames.contains(PENDING_STORE)) {
          db.createObjectStore(PENDING_STORE, { keyPath: 'key' })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => {
        console.error('failed to open indexedDB', request.error)
        resolve(null)
      }
    } catch (err) {
      console.error('indexedDB unavailable', err)
      resolve(null)
    }
  })
  return dbPromise
}

async function replaceStoredEntries(entries) {
  const db = await openClientDb()
  if (!db) return
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ENTRY_STORE, 'readwrite')
    const store = tx.objectStore(ENTRY_STORE)
    store.clear()
    entries.slice(0, MAX_STORED_ENTRIES).forEach(entry => {
      try { store.put(entry) } catch (err) { console.error('failed to cache entry', err) }
    })
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error || new Error('failed to cache entries'))
    tx.onabort = () => reject(tx.error || new Error('cache transaction aborted'))
  }).catch(err => console.error('failed to store feed entries', err))
}

async function persistEntry(entry) {
  const db = await openClientDb()
  if (!db) return
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ENTRY_STORE, 'readwrite')
    tx.objectStore(ENTRY_STORE).put(entry)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error || new Error('failed to persist entry'))
    tx.onabort = () => reject(tx.error || new Error('persist entry aborted'))
  }).catch(err => console.error('failed to persist entry', err))
}

async function loadStoredEntries() {
  const db = await openClientDb()
  if (!db) return []
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ENTRY_STORE, 'readonly')
    const request = tx.objectStore(ENTRY_STORE).getAll()
    request.onsuccess = () => {
      const result = Array.isArray(request.result) ? request.result : []
      const ordered = result
        .slice()
        .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
        .reverse()
      resolve(ordered.slice(0, MAX_STORED_ENTRIES))
    }
    request.onerror = () => reject(request.error || tx.error || new Error('failed to read cached entries'))
    tx.onabort = () => reject(tx.error || new Error('read cache aborted'))
  }).catch(err => {
    console.error('failed to load cached entries', err)
    return []
  })
}

async function clearCachedFeed(reason) {
  const db = await openClientDb()
  if (db) {
    await new Promise((resolve, reject) => {
      const tx = db.transaction([ENTRY_STORE, PENDING_STORE], 'readwrite')
      tx.objectStore(ENTRY_STORE).clear()
      tx.objectStore(PENDING_STORE).clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error || new Error('failed to clear cache'))
      tx.onabort = () => reject(tx.error || new Error('cache clear aborted'))
    }).catch(err => console.error('failed to clear cached feed', err))
  }
  Object.keys(feedState).forEach(key => delete feedState[key])
  Object.keys(entryCache).forEach(key => delete entryCache[key])
  if (reason) {
    status.set('offline-cache', reason, 'warn', { timeout: 6000 })
  }
}

async function validateEntryIntegrity(entry) {
  if (!canVerifyCachedEntries) return true
  const value = entry && entry.value
  if (!entry || typeof entry.key !== 'string' || !value || typeof value.signature !== 'string' || typeof value.author !== 'string') {
    return false
  }
  try {
    const canonical = canonicalizeMessage(value, true)
    const data = encodeCanonicalString(canonical)
    const digest = await crypto.subtle.digest('SHA-256', data)
    const key = '%' + bufToBase64(new Uint8Array(digest)) + '.sha256'
    if (key !== entry.key) return false
    const authorTag = parseTagged(value.author)
    const signatureTag = parseTagged(value.signature)
    if (!authorTag.base || !signatureTag.base) return false
    const publicKey = await importPublicKey(base64ToBuf(authorTag.base))
    const signatureBytes = base64ToBuf(signatureTag.base)
    const verified = await verifyBytes(publicKey, signatureBytes, data)
    return !!verified
  } catch (err) {
    console.warn('failed to validate cached entry', err)
    return false
  }
}

async function ensureValidCachedEntries(entries) {
  if (!canVerifyCachedEntries || !entries.length) return entries
  for (const entry of entries) {
    const ok = await validateEntryIntegrity(entry)
    if (!ok) return null
  }
  return entries
}


async function queuePendingMessage(entry, msg) {
  const db = await openClientDb()
  if (!db) return
  const record = {
    key: entry.key,
    msg: msg,
    created: Date.now()
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PENDING_STORE, 'readwrite')
    tx.objectStore(PENDING_STORE).put(record)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error || new Error('failed to queue message'))
    tx.onabort = () => reject(tx.error || new Error('queue transaction aborted'))
  }).catch(err => console.error('failed to queue pending message', err))
}

async function removePendingMessage(key) {
  const db = await openClientDb()
  if (!db) return
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PENDING_STORE, 'readwrite')
    tx.objectStore(PENDING_STORE).delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error || new Error('failed to remove pending message'))
    tx.onabort = () => reject(tx.error || new Error('remove pending aborted'))
  }).catch(err => console.error('failed to remove pending message', err))
}

async function loadPendingMessages() {
  const db = await openClientDb()
  if (!db) return []
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PENDING_STORE, 'readonly')
    const request = tx.objectStore(PENDING_STORE).getAll()
    request.onsuccess = () => {
      const result = Array.isArray(request.result) ? request.result : []
      resolve(result.sort((a, b) => (a.created || 0) - (b.created || 0)))
    }
    request.onerror = () => reject(request.error || tx.error || new Error('failed to read pending messages'))
    tx.onabort = () => reject(tx.error || new Error('pending read aborted'))
  }).catch(err => {
    console.error('failed to load pending messages', err)
    return []
  })
}

function createStatusManager(el) {
  const entries = new Map()
  let lastKey = null

  function render() {
    let entry = null
    if (lastKey && entries.has(lastKey)) {
      entry = entries.get(lastKey)
    } else if (entries.size) {
      const last = Array.from(entries.keys()).pop()
      entry = last ? entries.get(last) : null
      lastKey = last || null
    }
    const text = entry ? entry.text : ''
    const level = entry ? entry.level : ''
    if (el) {
      el.textContent = text || ''
      if (level) el.dataset.statusLevel = level
      else delete el.dataset.statusLevel
    }
    if (statusContainer) {
      statusContainer.hidden = false
    }
  }

  function clear(key) {
    const entry = entries.get(key)
    if (!entry) return
    if (entry.timeoutId) clearTimeout(entry.timeoutId)
    entries.delete(key)
    if (lastKey === key) {
      lastKey = entries.size ? Array.from(entries.keys()).pop() : null
    }
    render()
  }

  function set(key, text, level = 'info', opts = {}) {
    const prev = entries.get(key)
    if (prev && prev.timeoutId) clearTimeout(prev.timeoutId)
    const entry = { text, level, timeoutId: null }
    if (opts.timeout && opts.timeout > 0) {
      entry.timeoutId = setTimeout(() => clear(key), opts.timeout)
    }
    entries.set(key, entry)
    lastKey = key
    render()
  }

  function transient(text, level = 'info', timeout = 3000) {
    const key = `status-${Date.now()}-${Math.random().toString(36).slice(2)}`
    set(key, text, level, { timeout })
    return key
  }

  return { set, clear, transient }
}

function resetFeedView() {
  Object.keys(feedState).forEach(key => delete feedState[key])
  Object.keys(entryCache).forEach(key => delete entryCache[key])
  if (feedEl) feedEl.innerHTML = ''
}

function renderEntries(entries) {
  entries
    .slice()
    .reverse()
    .forEach(entry => {
      updateFeedState(entry)
      prependEntry(entry)
    })
}

function replaceFeed(entries) {
  resetFeedView()
  renderEntries(entries)
  if (currentMessageKey) updateMessageView(currentMessageKey)
}

function applyEntry(entry, options = {}) {
  if (!entry || !entry.value || !entry.key) return
  if (options.skipIfExists && entryCache[entry.key]) return
  updateFeedState(entry)
  if (options.insert !== false) prependEntry(entry)
  if (currentProfileId && entry.value && entry.value.author === currentProfileId) {
    renderProfileEntries(currentProfileId)
  }
  if (currentMessageKey && entry.key === currentMessageKey) {
    renderMessageDetail(entry)
  }
}

function getProfileRecord(authorId) {
  if (!authorId) return null
  if (!profileCache[authorId]) {
    profileCache[authorId] = {
      localName: '',
      localUpdated: 0,
      selfName: '',
      selfUpdated: 0,
      remoteName: '',
      remoteUpdated: 0,
      remoteNames: Object.create(null),
      localImage: null,
      selfImage: null,
      remoteImage: null
    }
  }
  return profileCache[authorId]
}

function getLocalProfileName(authorId) {
  const profile = profileCache[authorId]
  return profile && profile.localName ? profile.localName : ''
}

function getSelfDeclaredName(authorId) {
  const profile = profileCache[authorId]
  return profile && profile.selfName ? profile.selfName : ''
}

function getProfileName(authorId) {
  const profile = profileCache[authorId]
  if (!profile) return ''
  return profile.localName || profile.selfName || profile.remoteName || ''
}

function getDisplayName(authorId) {
  const name = getProfileName(authorId)
  return name || authorId || 'unknown'
}

function getProfileImage(authorId) {
  const profile = profileCache[authorId]
  if (!profile) return null
  return profile.localImage || profile.selfImage || profile.remoteImage || null
}

function updateAuthorDisplays(authorId) {
  if (!authorId) return
  const nodes = document.querySelectorAll('[data-author-id]')
  nodes.forEach(node => {
    if (node.getAttribute('data-author-id') !== authorId) return
    if (node.classList.contains('ssbd-author')) {
      node.textContent = getDisplayName(authorId)
    } else if (node.classList.contains('ssbd-avatar')) {
      applyAvatarToElement(node, authorId)
    }
  })
}

function normalizeImageRef(raw) {
  if (!raw) return null
  if (typeof raw === 'string') {
    return raw ? { link: raw } : null
  }
  if (typeof raw === 'object' && typeof raw.link === 'string' && raw.link) {
    return {
      link: raw.link,
      type: typeof raw.type === 'string' ? raw.type : undefined,
      size: typeof raw.size === 'number' ? raw.size : undefined
    }
  }
  return null
}

function setProfileImage(authorId, image, source) {
  const profile = getProfileRecord(authorId)
  if (!profile || !image) return
  if (source === 'local') profile.localImage = image
  else if (source === 'self') profile.selfImage = image
  else profile.remoteImage = image
  updateAuthorDisplays(authorId)
  if (currentProfileId === authorId) updateProfileAvatar(authorId)
}

function applyProfileMetadata(entry) {
  const value = entry && entry.value
  const content = value && value.content
  if (!content || content.type !== 'about') return
  const about = typeof content.about === 'string' ? content.about : null
  if (!about) return
  const author = value.author || ''
  const profile = getProfileRecord(about)
  if (!profile) return
  const timestamp = value.timestamp || Date.now()
  if (Object.prototype.hasOwnProperty.call(content, 'name')) {
    const raw = typeof content.name === 'string' ? content.name.trim() : ''
    if (currentFeedId && author === currentFeedId) {
      profile.localName = raw
      profile.localUpdated = timestamp
    } else if (author === about) {
      profile.selfName = raw
      profile.selfUpdated = timestamp
    } else {
      profile.remoteNames[author] = { name: raw, timestamp }
      if (!profile.remoteName || timestamp >= profile.remoteUpdated) {
        profile.remoteName = raw
        profile.remoteUpdated = timestamp
      }
    }
  }
  if (Object.prototype.hasOwnProperty.call(content, 'image')) {
    const imageRef = normalizeImageRef(content.image)
    if (imageRef) {
      if (currentFeedId && author === currentFeedId) {
        setProfileImage(about, imageRef, 'local')
      } else if (author === about) {
        setProfileImage(about, imageRef, 'self')
      } else {
        setProfileImage(about, imageRef, 'remote')
      }
    }
  }
  updateAuthorDisplays(about)
  if (currentProfileId === about) {
    updateProfileForm(about)
  }
}

function applyContactMetadata(entry) {
  const value = entry && entry.value
  const content = value && value.content
  if (!content || content.type !== 'contact') return
  const contact = typeof content.contact === 'string' ? content.contact : ''
  if (!contact) return
  const author = value.author || ''
  if (author === currentFeedId) {
    followState.set(contact, Boolean(content.following))
    if (currentProfileId === contact) {
      updateFollowButtons(contact)
    }
  }
}

function renderAvatarInitials(author) {
  const display = getDisplayName(author)
  if (!display || typeof display !== 'string') return '??'
  const normalized = display.replace(/^@/, '').trim()
  if (!normalized) return '??'
  const parts = normalized.split(/[\s.]+/).filter(Boolean)
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase()
  }
  return parts[0].slice(0, 2).toUpperCase()
}

function setAvatarFallback(el, authorId) {
  if (!el) return
  el.classList.remove('ssbd-avatar-image')
  el.style.backgroundImage = ''
  el.textContent = renderAvatarInitials(authorId)
  delete el.dataset.avatarHash
}

function fetchBlobUrl(hash) {
  if (avatarUrlCache.has(hash)) return Promise.resolve(avatarUrlCache.get(hash))
  if (avatarFetchPromises.has(hash)) return avatarFetchPromises.get(hash)
  const promise = fetch(httpBase + '/blobs/' + encodeURIComponent(hash))
    .then(res => {
      if (!res.ok) throw new Error('blob fetch failed')
      return res.blob()
    })
    .then(blob => {
      const url = URL.createObjectURL(blob)
      avatarUrlCache.set(hash, url)
      avatarFetchPromises.delete(hash)
      return url
    })
    .catch(err => {
      avatarFetchPromises.delete(hash)
      throw err
    })
  avatarFetchPromises.set(hash, promise)
  return promise
}

function applyAvatarToElement(el, authorId) {
  if (!el) return
  if (!authorId) {
    setAvatarFallback(el, authorId)
    return
  }
  const image = getProfileImage(authorId)
  if (!image || !image.link) {
    setAvatarFallback(el, authorId)
    return
  }
  const targetHash = image.link
  el.dataset.avatarHash = targetHash
  fetchBlobUrl(targetHash)
    .then(url => {
      if (el.dataset.avatarHash !== targetHash) return
      el.classList.add('ssbd-avatar-image')
      el.style.backgroundImage = `url(${url})`
      el.textContent = ''
    })
    .catch(() => {
      if (el.dataset.avatarHash === targetHash) {
        setAvatarFallback(el, authorId)
      }
    })
}

function updateProfileAvatar(authorId) {
  if (!profileAvatarEl) return
  if (!authorId) {
    setAvatarFallback(profileAvatarEl, authorId)
    return
  }
  profileAvatarEl.setAttribute('data-author-id', authorId)
  applyAvatarToElement(profileAvatarEl, authorId)
}

function updateFollowButtons(authorId) {
  if (!followActionsEl || !followBtn || !unfollowBtn) return
  if (!authorId || !authorId.startsWith('@') || (currentFeedId && authorId === currentFeedId)) {
    followActionsEl.hidden = true
    return
  }
  followActionsEl.hidden = false
  const following = followState.get(authorId) === true
  followBtn.disabled = !browserKeys || following
  unfollowBtn.disabled = !browserKeys || !following
}

function formatTimestamp(timestamp) {
  if (!timestamp) return 'unknown time'
  const date = new Date(timestamp)
  const now = Date.now()
  const diff = Math.max(0, now - date.getTime())
  const sec = Math.floor(diff / 1000)
  if (sec < 45) return 'just now'
  if (sec < 90) return '1m ago'
  const mins = Math.floor(sec / 60)
  if (mins < 60) return mins + 'm ago'
  const hours = Math.floor(mins / 60)
  if (hours < 24) return hours + 'h ago'
  const days = Math.floor(hours / 24)
  if (days < 30) return days + 'd ago'
  const months = Math.floor(days / 30)
  if (months < 12) return months + 'mo ago'
  const years = Math.floor(months / 12)
  return years + 'y ago'
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function linkify(text) {
  return text.replace(
    /(https?:\/\/[^\s<]+)/g,
    url => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
  )
}

function formatParagraphs(text) {
  return text
    .trim()
    .split(/\n{2,}/)
    .map(chunk => {
      const withBreaks = chunk.replace(/\n/g, '<br>')
      return `<p>${withBreaks}</p>`
    })
    .join('')
}

function renderPostContent(value) {
  const content = value.content || {}
  const wrapper = document.createElement('div')
  wrapper.className = 'ssbd-post'

  if (content.root) {
    const reply = document.createElement('div')
    reply.className = 'ssbd-reply-ref'
    const link = document.createElement('a')
    link.href = `#${content.root}`
    link.textContent = 're: ' + content.root.slice(0, 10) + '…'
    reply.appendChild(link)
    wrapper.appendChild(reply)
  }

  const body = document.createElement('div')
  body.className = 'ssbd-post-body markdown'
  const text = typeof content.text === 'string' ? content.text : ''
  const html = formatParagraphs(linkify(escapeHtml(text)))
  body.innerHTML = html || '<p><em>(empty post)</em></p>'
  wrapper.appendChild(body)
  return wrapper
}

function renderRawContent(value) {
  const pre = document.createElement('pre')
  pre.className = 'ssbd-raw'
  pre.textContent = JSON.stringify(value.content, null, 2)
  return pre
}

function renderMessageContent(value) {
  const content = value.content || {}
  if (content.type === 'post') {
    return renderPostContent(value)
  }
  if (content.type === 'about') {
    return renderAboutContent(value)
  }
  if (content.type === 'contact') {
    return renderContactContent(value)
  }
  if (content.type === 'git-update') {
    return renderGitUpdateContent(value)
  }
  return renderRawContent(value)
}

function renderEntry(entry) {
  const value = entry.value || {}
  const card = document.createElement('article')
  card.className = 'ssbd-entry'

  const header = document.createElement('header')
  header.className = 'ssbd-entry-header'

  const avatar = document.createElement('div')
  avatar.className = 'ssbd-avatar'
  avatar.textContent = renderAvatarInitials(value.author)
  if (value.author) avatar.setAttribute('data-author-id', value.author)
  applyAvatarToElement(avatar, value.author)

  const meta = document.createElement('div')
  meta.className = 'ssbd-entry-meta'

  const author = document.createElement('a')
  author.className = 'ssbd-author'
  if (value.author) {
    author.href = '#' + value.author
    author.setAttribute('data-author-id', value.author)
  } else {
    author.href = '#'
  }
  author.textContent = getDisplayName(value.author)

  const subMeta = document.createElement('div')
  subMeta.className = 'ssbd-entry-submeta'
  const seqSpan = document.createElement('span')
  seqSpan.textContent = `#${value.sequence || '?'}`
  const timeLink = document.createElement('a')
  timeLink.href = '#' + entry.key
  timeLink.textContent = formatTimestamp(value.timestamp)
  timeLink.title = new Date(value.timestamp).toLocaleString()
  subMeta.appendChild(seqSpan)
  subMeta.appendChild(document.createTextNode(' · '))
  subMeta.appendChild(timeLink)

  meta.appendChild(author)
  meta.appendChild(subMeta)

  header.appendChild(avatar)
  header.appendChild(meta)

  const body = document.createElement('div')
  body.className = 'ssbd-entry-body'
  body.appendChild(renderMessageContent(value))

  card.appendChild(header)
  card.appendChild(body)
  return card
}

function prependEntry(entry) {
  if (!feedEl) return
  const el = renderEntry(entry)
  feedEl.insertBefore(el, feedEl.firstChild)
}

function renderProfileEntries(authorId) {
  if (!profileFeedEntries) return
  profileFeedEntries.innerHTML = ''
  if (!authorId) {
    const empty = document.createElement('p')
    empty.className = 'ssbd-empty'
    empty.textContent = 'Select a profile to see their posts.'
    profileFeedEntries.appendChild(empty)
    return
  }
  const items = Object.values(entryCache)
    .filter(entry => entry && entry.value && entry.value.author === authorId)
    .sort((a, b) => (b.value.timestamp || 0) - (a.value.timestamp || 0))
  if (!items.length) {
    const empty = document.createElement('p')
    empty.className = 'ssbd-empty'
    empty.textContent = 'No posts yet.'
    profileFeedEntries.appendChild(empty)
    return
  }
  items.forEach(entry => {
    profileFeedEntries.appendChild(renderEntry(entry))
  })
}

function renderAboutContent(value) {
  const content = value.content || {}
  const wrapper = document.createElement('div')
  wrapper.className = 'ssbd-about'
  const actions = document.createElement('div')
  actions.className = 'ssbd-about-actions'
  const trimmedName = typeof content.name === 'string' ? content.name.trim() : ''
  if (trimmedName) {
    const nameItem = document.createElement('div')
    nameItem.className = 'ssbd-about-item'
    nameItem.textContent = `Set display name to “${trimmedName}”.`
    actions.appendChild(nameItem)
  }
  const imageRef = normalizeImageRef(content.image)
  if (imageRef && imageRef.link) {
    const imageItem = document.createElement('div')
    imageItem.className = 'ssbd-about-item ssbd-about-image'
    const avatar = document.createElement('div')
    avatar.className = 'ssbd-avatar ssbd-avatar-large'
    avatar.textContent = ''
    avatar.dataset.avatarHash = imageRef.link
    imageItem.appendChild(avatar)
    const note = document.createElement('span')
    note.textContent = 'Updated avatar image.'
    imageItem.appendChild(note)
    actions.appendChild(imageItem)
    fetchBlobUrl(imageRef.link)
      .then(url => {
        if (avatar.dataset.avatarHash !== imageRef.link) return
        avatar.classList.add('ssbd-avatar-image')
        avatar.style.backgroundImage = `url(${url})`
      })
      .catch(() => {
        avatar.textContent = '??'
      })
  }
  if (!actions.childNodes.length) {
    const fallback = document.createElement('div')
    fallback.className = 'ssbd-about-item'
    fallback.textContent = 'Profile metadata updated.'
    actions.appendChild(fallback)
  }
  wrapper.appendChild(actions)
  return wrapper
}

function renderContactContent(value) {
  const content = value.content || {}
  const wrapper = document.createElement('div')
  wrapper.className = 'ssbd-about'
  const actions = document.createElement('div')
  actions.className = 'ssbd-about-actions'
  const target = typeof content.contact === 'string' ? content.contact : ''
  const following = content.following !== false
  const line = document.createElement('div')
  line.className = 'ssbd-about-item'
  if (target) {
    const nameLink = document.createElement('a')
    nameLink.href = '#' + target
    nameLink.textContent = getDisplayName(target) || target
    nameLink.setAttribute('data-author-id', target)
    line.append(following ? 'Started following ' : 'Stopped following ', nameLink, '.')
  } else {
    line.textContent = following ? 'Started following.' : 'Stopped following.'
  }
  actions.appendChild(line)
  wrapper.appendChild(actions)
  return wrapper
}

function renderGitUpdateContent(value) {
  const content = value.content || {}
  const wrapper = document.createElement('div')
  wrapper.className = 'ssbd-git'
  const repoLine = document.createElement('div')
  const repo = typeof content.repo === 'string' ? content.repo : ''
  if (repo) {
    const repoLink = document.createElement('a')
    repoLink.href = '#' + repo
    repoLink.textContent = repo.slice(0, 12) + '…'
    repoLine.textContent = 'Repo '
    repoLine.appendChild(repoLink)
  } else {
    repoLine.textContent = 'Git repository update'
  }
  wrapper.appendChild(repoLine)
  const branchNames = Array.isArray(content.refsBranch) ? content.refsBranch : []
  const sections = []
  const appendListSection = (title, items, grouped) => {
    if (!items.length) return
    const section = document.createElement('div')
    section.className = 'ssbd-git-section'
    if (title) {
      const heading = document.createElement('div')
      heading.className = 'ssbd-git-section-title'
      heading.textContent = title
      section.appendChild(heading)
    }
    if (grouped) {
      grouped.forEach(group => section.appendChild(group))
    } else {
      const list = document.createElement('ul')
      list.className = 'ssbd-git-list'
      items.forEach(item => list.appendChild(item))
      section.appendChild(list)
    }
    wrapper.appendChild(section)
  }

  const branchItems = branchNames.map(ref => {
    const li = document.createElement('li')
    li.textContent = ref
    return li
  })
  appendListSection(branchNames.length ? 'Branches' : '', branchItems)

  const packItems = (Array.isArray(content.packs) ? content.packs : []).map(pack => {
    const container = document.createElement('div')
    const header = document.createElement('div')
    const linkText = pack && typeof pack.link === 'string' ? pack.link : ''
    if (linkText) {
      const link = document.createElement('a')
      link.href = '#' + linkText
      link.textContent = linkText.slice(0, 12) + '…'
      header.append('Pack ', link)
    } else {
      header.textContent = 'Pack'
    }
    if (typeof pack.size === 'number') header.append(` (${pack.size} bytes)`)
    container.appendChild(header)
    return container
  })
  appendListSection(packItems.length ? 'Packs' : '', [], packItems)

  const indexItems = (Array.isArray(content.indexes) ? content.indexes : []).map(idx => {
    const container = document.createElement('div')
    const header = document.createElement('div')
    const linkText = idx && typeof idx.link === 'string' ? idx.link : ''
    if (linkText) {
      const link = document.createElement('a')
      link.href = '#' + linkText
      link.textContent = linkText.slice(0, 12) + '…'
      header.append('Index ', link)
    } else {
      header.textContent = 'Index'
    }
    if (typeof idx.size === 'number') header.append(` (${idx.size} bytes)`)
    container.appendChild(header)
    return container
  })
  appendListSection(indexItems.length ? 'Indexes' : '', [], indexItems)

  const refEntries = content.refs && typeof content.refs === 'object' ? Object.entries(content.refs) : []
  const refItems = refEntries.map(([key, value]) => {
    const li = document.createElement('li')
    li.textContent = `${key}: ${String(value)}`
    return li
  })
  appendListSection(refItems.length ? 'Refs' : '', refItems)

  const commitItems = (Array.isArray(content.commits) ? content.commits : []).map(commit => {
    const li = document.createElement('li')
    const title = typeof commit.title === 'string' ? commit.title : '(no title)'
    const sha1 = typeof commit.sha1 === 'string' ? commit.sha1 : ''
    li.textContent = title + ' '
    if (sha1) {
      const code = document.createElement('code')
      code.textContent = sha1.slice(0, 12)
      li.appendChild(code)
    }
    if (Array.isArray(commit.parents) && commit.parents.length) {
      const parents = document.createElement('div')
      parents.textContent = 'parents: ' + commit.parents.map(p => p.slice(0, 8)).join(', ')
      li.appendChild(parents)
    }
    return li
  })
  appendListSection(commitItems.length ? 'Commits' : '', commitItems)

  const tagItems = (Array.isArray(content.tags) ? content.tags : []).map(tag => {
    const li = document.createElement('li')
    li.textContent = String(tag)
    return li
  })
  appendListSection(tagItems.length ? 'Tags' : '', tagItems)

  const objectIdItems = (Array.isArray(content.object_ids) ? content.object_ids : []).map(id => {
    const li = document.createElement('li')
    li.textContent = id
    return li
  })
  appendListSection(objectIdItems.length ? 'Object IDs' : '', objectIdItems)
  return wrapper
}

function findEntryByKey(key) {
  if (!key) return null
  return entryCache[key] || null
}

function renderMessagePlaceholder(text) {
  if (messageTitleEl) messageTitleEl.textContent = 'Message'
  if (messageIdEl) messageIdEl.textContent = currentMessageKey || ''
  if (messageMetaEl) {
    messageMetaEl.innerHTML = ''
    if (text) {
      const span = document.createElement('span')
      span.textContent = text
      messageMetaEl.appendChild(span)
    }
  }
  if (messageBodyEl) messageBodyEl.innerHTML = ''
  if (messageRawEl) {
    messageRawEl.textContent = ''
    if (messageRawEl.closest('details')) {
      messageRawEl.closest('details').open = false
    }
  }
}

function renderMessageDetail(entry) {
  if (!entry) {
    renderMessagePlaceholder('Message not found in current log.')
    return
  }
  const value = entry.value || {}
  if (messageTitleEl) {
    const type = value.content && value.content.type
    messageTitleEl.textContent = type ? type + ' message' : 'Message'
  }
  if (messageIdEl) {
    messageIdEl.textContent = entry.key || ''
  }
  if (messageMetaEl) {
    messageMetaEl.innerHTML = ''
    const metaWrapper = document.createElement('div')
    metaWrapper.className = 'ssbd-message-author'
    const avatar = document.createElement('div')
    avatar.className = 'ssbd-avatar ssbd-avatar-medium'
    avatar.textContent = renderAvatarInitials(value.author)
    if (value.author) avatar.setAttribute('data-author-id', value.author)
    applyAvatarToElement(avatar, value.author)
    const authorMeta = document.createElement('div')
    authorMeta.className = 'ssbd-message-author-meta'
    const authorLink = document.createElement('a')
    authorLink.className = 'ssbd-author'
    if (value.author) {
      authorLink.href = '#' + value.author
      authorLink.setAttribute('data-author-id', value.author)
    } else {
      authorLink.href = '#'
    }
    authorLink.textContent = getDisplayName(value.author)
    authorMeta.appendChild(authorLink)
    if (value.timestamp) {
      const time = document.createElement('time')
      time.textContent = formatTimestamp(value.timestamp)
      time.dateTime = new Date(value.timestamp).toISOString()
      time.title = new Date(value.timestamp).toLocaleString()
      authorMeta.appendChild(time)
    }
    metaWrapper.appendChild(avatar)
    metaWrapper.appendChild(authorMeta)
    messageMetaEl.appendChild(metaWrapper)
    const subMeta = document.createElement('div')
    subMeta.className = 'ssbd-message-submeta'
    if (value.sequence != null) {
      const seq = document.createElement('span')
      seq.textContent = `#${value.sequence}`
      subMeta.appendChild(seq)
    }
    if (entry && entry.key) {
      const keyLink = document.createElement('a')
      keyLink.href = '#' + entry.key
      keyLink.textContent = entry.key.slice(0, 10) + '…'
      subMeta.appendChild(keyLink)
    }
    if (value.timestamp) {
      const absolute = document.createElement('span')
      absolute.textContent = new Date(value.timestamp).toLocaleString()
      subMeta.appendChild(absolute)
    }
    if (subMeta.childNodes.length) {
      messageMetaEl.appendChild(subMeta)
    }
  }
  if (messageBodyEl) {
    messageBodyEl.innerHTML = ''
    messageBodyEl.appendChild(renderMessageContent(value))
  }
  if (messageRawEl) {
    messageRawEl.textContent = JSON.stringify(value, null, 2)
    if (messageRawEl.closest('details')) {
      messageRawEl.closest('details').open = false
    }
  }
}

function updateMessageView(key) {
  if (!messageViewEl) return
  if (!key) {
    renderMessagePlaceholder('Select a message to view details.')
    return
  }
  const entry = findEntryByKey(key)
  if (entry) renderMessageDetail(entry)
  else renderMessagePlaceholder('Message not yet available in local feed.')
}

function updateProfileForm(authorId) {
  if (!profileViewEl) return
  if (!authorId) {
    if (profileTitleEl) profileTitleEl.textContent = 'Profile'
    if (profileIdEl) profileIdEl.textContent = ''
    if (profileSelfNameEl) profileSelfNameEl.textContent = 'Select a profile to see details.'
    if (profileNameLabel) profileNameLabel.textContent = 'Display name'
    if (profileNameInput) {
      profileNameInput.value = ''
      profileNameInput.disabled = true
    }
    if (profileSaveBtn) profileSaveBtn.disabled = true
    renderProfileEntries(null)
    updateProfileAvatar(null)
    updateFollowButtons(null)
    return
  }
  if (typeof authorId !== 'string' || !authorId.startsWith('@')) {
    if (profileTitleEl) profileTitleEl.textContent = 'Profile'
    if (profileIdEl) profileIdEl.textContent = authorId || ''
    if (profileSelfNameEl) profileSelfNameEl.textContent = 'Invalid profile identifier.'
    if (profileNameLabel) profileNameLabel.textContent = 'Display name'
    if (profileNameInput) {
      profileNameInput.value = ''
      profileNameInput.disabled = true
    }
    if (profileSaveBtn) profileSaveBtn.disabled = true
    renderProfileEntries(null)
    updateProfileAvatar(null)
    updateFollowButtons(null)
    return
  }
  const profile = getProfileRecord(authorId) || {}
  const displayName = getDisplayName(authorId)
  if (profileTitleEl) {
    profileTitleEl.textContent = displayName
    profileTitleEl.setAttribute('data-author-id', authorId)
  }
  if (profileIdEl) {
    profileIdEl.textContent = authorId
    profileIdEl.setAttribute('data-author-id', authorId)
  }
  if (profileSelfNameEl) {
    const profile = getProfileRecord(authorId)
    const selfDeclared = profile ? profile.selfName || '' : ''
    if (authorId === currentFeedId) {
      profileSelfNameEl.textContent = selfDeclared ? `You publish as "${selfDeclared}".` : ''
    } else {
      profileSelfNameEl.textContent = selfDeclared ? `They call themselves "${selfDeclared}".` : ''
    }
  }
  if (profileNameLabel) {
    profileNameLabel.textContent = authorId === currentFeedId ? 'Set your display name' : 'Name this contact'
  }
  if (profileNameInput) {
    const localName = getLocalProfileName(authorId)
    if (document.activeElement !== profileNameInput) {
      profileNameInput.value = localName
    }
    profileNameInput.placeholder = authorId === currentFeedId ? 'Your name' : 'Nickname for this contact'
    profileNameInput.disabled = !browserKeys
  }
  if (profileSaveBtn) {
    profileSaveBtn.disabled = !browserKeys
  }
  updateProfileAvatar(authorId)
  renderProfileEntries(authorId)
  updateFollowButtons(authorId)
}

function updateFeedState(entry) {
  if (!entry || !entry.value) return
  applyProfileMetadata(entry)
  applyContactMetadata(entry)
  const value = entry.value
  if (!value.author) return
  entryCache[entry.key] = entry
  feedState[value.author] = {
    id: entry.key,
    sequence: value.sequence,
    timestamp: value.timestamp
  }
}

async function loadLocalFeed() {
  try {
    const stored = await loadStoredEntries()
    const entries = await ensureValidCachedEntries(stored)
    if (entries === null) {
      await clearCachedFeed('Detected malformed offline feed; cleared cached entries')
      return
    }
    if (entries && entries.length) {
      replaceFeed(entries)
      if (currentProfileId) updateProfileForm(currentProfileId)
      isInitialOfflineLoad = true
      status.set('offline-cache', 'Loaded offline feed (' + entries.length + ' entries)', 'info', { timeout: 4000 })
    }
  } catch (err) {
    console.error('failed to load offline feed', err)
  }
}

function loadFeed() {
  status.set('feed', 'Loading feed…')
  fetch(httpBase + '/feed')
    .then(res => res.json())
    .then(entries => {
      if (!Array.isArray(entries)) entries = []
      replaceFeed(entries)
      replaceStoredEntries(entries)
      isInitialOfflineLoad = false
      status.set('feed', 'Feed ready (' + entries.length + ' entries)', 'success', { timeout: 4000 })
      flushPendingQueue()
      if (currentProfileId) updateProfileForm(currentProfileId)
    })
    .catch(err => {
      console.error('failed to load feed', err)
      if (isInitialOfflineLoad) {
        status.set('feed', 'Offline mode: showing cached feed', 'warn', { timeout: 5000 })
      } else {
        status.set('feed', 'Failed to load feed: ' + err.message, 'error', { timeout: 6000 })
      }
    })
}

async function wipeLocalCache() {
  if (!deleteBtn) return
  const confirmed = window.confirm('Delete all cached entries on this device? The server copy will stay intact.')
  if (!confirmed) return
  deleteBtn.disabled = true
  status.set('reset', 'Clearing local cache…', 'warn')
  try {
    await clearCachedFeed('Offline cache cleared')
    resetFeedView()
    loadFeed()
    status.set('reset', 'Local cache cleared; reloading…', 'success', { timeout: 5000 })
  } catch (err) {
    console.error('local cache reset failed', err)
    status.set('reset', 'Delete failed: ' + err.message, 'error', { timeout: 6000 })
  } finally {
    deleteBtn.disabled = false
  }
}

function setActiveNav(route) {
  const feedActive = route === 'feed'
  const profileActive = route === 'profile' && currentProfileId && currentFeedId && currentProfileId === currentFeedId
  if (navFeedLink) navFeedLink.classList.toggle('active', feedActive)
  if (navProfileLink) navProfileLink.classList.toggle('active', profileActive)
}

function updateNavProfileLink() {
  if (!navProfileLink) return
  if (currentFeedId) {
    navProfileLink.href = '#' + currentFeedId
  } else {
    navProfileLink.href = '#me'
  }
}

function parseRoute() {
  const hash = window.location.hash || ''
  const clean = hash.replace(/^#/, '')
  if (!clean || clean === '/' || clean === 'feed' || clean === '/feed') {
    return { type: 'feed' }
  }
  const trimmed = clean.replace(/^\//, '')
  if (!trimmed || trimmed === 'feed') return { type: 'feed' }
  if (trimmed.startsWith('profile/')) {
    return { type: 'identifier', target: trimmed.slice('profile/'.length) }
  }
  if (trimmed === 'profile') return { type: 'identifier', target: 'me' }
  return { type: 'identifier', target: trimmed }
}

function resolveIdentifier(raw) {
  if (!raw) return ''
  if (raw === 'me' || raw === 'self') return currentFeedId || ''
  return raw
}

function showFeedView() {
  currentRoute = { type: 'feed' }
  currentProfileId = null
  currentMessageKey = null
  if (feedViewEl) feedViewEl.hidden = false
  if (profileViewEl) profileViewEl.hidden = true
  if (messageViewEl) messageViewEl.hidden = true
  setActiveNav('feed')
}

function showProfileView(profileId) {
  currentRoute = { type: 'profile', id: profileId || null }
  currentProfileId = profileId || null
  currentMessageKey = null
  if (feedViewEl) feedViewEl.hidden = true
  if (profileViewEl) profileViewEl.hidden = false
  if (messageViewEl) messageViewEl.hidden = true
  updateProfileForm(currentProfileId)
  setActiveNav('profile')
}

function showMessageView(messageKey) {
  currentRoute = { type: 'message', key: messageKey || null }
  currentProfileId = null
  currentMessageKey = messageKey || null
  if (feedViewEl) feedViewEl.hidden = true
  if (profileViewEl) profileViewEl.hidden = true
  if (messageViewEl) messageViewEl.hidden = false
  updateMessageView(currentMessageKey)
  setActiveNav(null)
}

function handleRouteChange() {
  const route = parseRoute()
  if (route.type === 'identifier') {
    const resolved = resolveIdentifier(route.target)
    if (!resolved) {
      if (route.target === 'me' || route.target === 'self') {
        status.set('profile', 'Profile not available until keys load', 'warn', { timeout: 4000 })
      }
      showFeedView()
      return
    }
    if (resolved.startsWith('%')) {
      showMessageView(resolved)
      return
    }
    if (resolved.startsWith('@')) {
      showProfileView(resolved)
      return
    }
    const entry = findEntryByKey(resolved)
    if (entry) {
      showMessageView(resolved)
    } else {
      showProfileView(resolved)
    }
  } else {
    showFeedView()
  }
}

function postSignedMessage(msg) {
  return fetch(httpBase + '/publish', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ msg: msg })
  }).then(res => {
    if (!res.ok) {
      return res
        .json()
        .catch(() => ({}))
        .then(body => {
          const err = new Error((body && body.error) || 'publish failed')
          err.status = res.status
          throw err
        })
    }
    return res.json()
  })
}

function scheduleFlushRetry() {
  if (retryFlushTimer) return
  retryFlushTimer = setTimeout(() => {
    retryFlushTimer = null
    flushPendingQueue()
  }, 5000)
}

async function flushPendingQueue() {
  if (flushInProgress) return
  flushInProgress = true
  try {
    const pending = await loadPendingMessages()
    if (!pending.length) return
    status.set('sync', 'Syncing ' + pending.length + ' offline entr' + (pending.length === 1 ? 'y' : 'ies') + '…')
    for (const item of pending) {
      try {
        const serverEntry = await postSignedMessage(item.msg)
        await persistEntry(serverEntry)
        await removePendingMessage(item.key)
        if (!entryCache[serverEntry.key]) {
          applyEntry(serverEntry)
        }
      } catch (err) {
        console.warn('failed to flush pending entry', err)
        status.set('sync', 'Sync waiting: ' + err.message, 'warn', { timeout: 5000 })
        scheduleFlushRetry()
        break
      }
    }
    status.set('sync', 'Offline entries synced', 'success', { timeout: 3000 })
  } finally {
    flushInProgress = false
  }
}

function startSocket() {
  const socket = new WebSocket(wsBase + '/sync')
  socket.addEventListener('open', () => {
    status.set('socket', 'Live updates connected', 'success', { timeout: 3000 })
    flushPendingQueue()
  })
  socket.addEventListener('message', event => {
    try {
      const data = JSON.parse(event.data)
      if (data && data.type === 'entry' && data.entry) {
        if (!entryCache[data.entry.key]) {
          applyEntry(data.entry)
        }
        persistEntry(data.entry)
        if (data.entry.key) removePendingMessage(data.entry.key)
      }
    } catch (err) {
      console.error('failed to parse socket payload', err)
    }
  })
  socket.addEventListener('close', () => {
    status.set('socket', 'Live updates disconnected; retrying…', 'warn')
    setTimeout(startSocket, 2000)
  })
  socket.addEventListener('error', err => {
    console.warn('socket error (will retry)', err)
    status.set('socket', 'Live updates error; retrying…', 'warn', { timeout: 4000 })
    socket.close()
  })
}

function loadStoredKeys() {
  try {
    const raw = localStorage.getItem('ssbd_browser_keys')
    if (!raw) return null
    return JSON.parse(raw)
  } catch (err) {
    console.error('failed to parse stored keys', err)
    return null
  }
}

function saveKeys(keys) {
  try {
    localStorage.setItem('ssbd_browser_keys', JSON.stringify(keys))
  } catch (err) {
    console.error('failed to persist keys', err)
  }
}

async function ensureBrowserKeys() {
  const stored = loadStoredKeys()
  if (stored && stored.public && stored.privatePkcs8) {
    browserKeys = stored
    currentFeedId = '@' + stored.public + '.ed25519'
    signKeyPromise = importPrivateKey(base64ToBuf(stored.privatePkcs8))
    status.set('keys', 'Loaded browser keys for ' + currentFeedId, 'info', { timeout: 4000 })
    updateNavProfileLink()
    handleRouteChange()
    return stored
  }
  status.set('keys', 'Generating browser keys…', 'info')
  const generated = await generateEd25519Keypair()
  const publicBase64 = bufToBase64(generated.publicKeyBytes)
  const privatePkcs8 = bufToBase64(generated.privateKeyPkcs8)
  browserKeys = {
    public: publicBase64,
    privatePkcs8: privatePkcs8
  }
  currentFeedId = '@' + publicBase64 + '.ed25519'
  saveKeys(browserKeys)
  signKeyPromise = importPrivateKey(generated.privateKeyPkcs8)
  status.set('keys', 'Generated browser keys for ' + currentFeedId, 'success', { timeout: 4000 })
  updateNavProfileLink()
  handleRouteChange()
  return browserKeys
}

function buildUnsignedMessage(content) {
  const state = feedState[currentFeedId] || null
  let timestamp = Date.now()
  if (state && timestamp <= state.timestamp) timestamp = state.timestamp + 1
  return {
    previous: state ? state.id : null,
    author: currentFeedId,
    sequence: state ? state.sequence + 1 : 1,
    timestamp: timestamp,
    hash: 'sha256',
    content: content
  }
}

async function buildSignedMessage(content) {
  if (!browserKeys) throw new Error('no browser keys')
  const unsigned = buildUnsignedMessage(content)
  const signKey = await signKeyPromise
  const data = encodeCanonicalString(canonicalizeMessage(unsigned))
  const signatureBytes = await crypto.subtle.sign({ name: 'Ed25519' }, signKey, data)
  return Object.assign({}, unsigned, { signature: toTaggedSig(new Uint8Array(signatureBytes)) })
}

async function createLocalEntryFromSigned(msg) {
  const canonical = canonicalizeMessage(msg, true)
  const data = encodeCanonicalString(canonical)
  const hash = await crypto.subtle.digest('SHA-256', data)
  const key = '%' + bufToBase64(new Uint8Array(hash)) + '.sha256'
  return {
    key: key,
    value: msg,
    timestamp: Date.now()
  }
}

async function publishContentUpdate(content, options = {}) {
  const statusKey = options.statusKey || 'status'
  const progressLabel = options.progressLabel || 'Publishing…'
  const queuedLabel = options.queuedLabel || (seq => 'Queued #' + seq)
  const successLabel = options.successLabel || 'Update published'
  const offlineLabel = options.offlineLabel || 'Offline: update will sync soon'
  const seqLabel = value => (typeof value === 'number' ? value : '?')
  status.set(statusKey, progressLabel)
  const msg = await buildSignedMessage(content)
  const entry = await createLocalEntryFromSigned(msg)
  applyEntry(entry)
  await persistEntry(entry)
  await queuePendingMessage(entry, msg)
  const seq = entry && entry.value && entry.value.sequence
  const queuedText = typeof queuedLabel === 'function' ? queuedLabel(seqLabel(seq)) : queuedLabel
  status.set(statusKey, queuedText, 'info', { timeout: 3000 })
  try {
    const serverEntry = await postSignedMessage(msg)
    await persistEntry(serverEntry)
    await removePendingMessage(entry.key)
    if (!entryCache[serverEntry.key]) {
      applyEntry(serverEntry)
    }
    status.set(statusKey, successLabel, 'success', { timeout: 4000 })
    return true
  } catch (err) {
    console.warn('about update deferred', err)
    status.set(statusKey, offlineLabel, 'warn', { timeout: 5000 })
    scheduleFlushRetry()
    return false
  }
}

async function publishContactUpdate(contactId, following) {
  if (!contactId || !contactId.startsWith('@')) {
    status.set('follow', 'Invalid contact id', 'error', { timeout: 4000 })
    return
  }
  if (!browserKeys || !currentFeedId) {
    status.set('follow', 'Browser keys not ready', 'error', { timeout: 4000 })
    return
  }
  const statusKey = 'follow'
  const label = following ? 'Following…' : 'Unfollowing…'
  status.set(statusKey, label)
  const content = { type: 'contact', contact: contactId, following }
  const successLabel = following ? 'Now following' : 'Unfollowed'
  const offlineLabel = following ? 'Offline: follow will sync soon' : 'Offline: unfollow will sync soon'
  const queuedLabel = seq => (following ? 'Queued follow #' + seq : 'Queued unfollow #' + seq)
  try {
    await publishContentUpdate(content, {
      statusKey,
      progressLabel: label,
      queuedLabel,
      successLabel,
      offlineLabel
    })
  } catch (err) {
    status.set(statusKey, 'Follow update failed: ' + err.message, 'error', { timeout: 6000 })
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error || new Error('file read failed'))
    reader.readAsDataURL(file)
  })
}

function loadImageFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image load failed'))
    img.src = typeof dataUrl === 'string' ? dataUrl : ''
  })
}

async function prepareAvatarBlob(file) {
  const dataUrl = await readFileAsDataUrl(file)
  const img = await loadImageFromDataUrl(dataUrl)
  const canvas = document.createElement('canvas')
  const size = 512
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas unsupported')
  const minSide = Math.max(1, Math.min(img.naturalWidth || img.width, img.naturalHeight || img.height))
  const sx = ((img.naturalWidth || img.width) - minSide) / 2
  const sy = ((img.naturalHeight || img.height) - minSide) / 2
  ctx.clearRect(0, 0, size, size)
  ctx.drawImage(img, sx, sy, minSide, minSide, 0, 0, size, size)
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png', 0.92))
  if (!blob) throw new Error('failed to process image')
  return blob
}

async function uploadAvatarBlob(blob) {
  const res = await fetch(httpBase + '/blobs/add', {
    method: 'POST',
    headers: { 'content-type': blob.type || 'application/octet-stream' },
    body: blob
  })
  const text = (await res.text()).trim()
  if (!res.ok) {
    throw new Error(text || 'avatar upload failed')
  }
  if (!BLOB_HASH_REGEX.test(text)) {
    throw new Error('invalid blob hash returned')
  }
  return text
}

async function uploadAvatarImage() {
  if (!avatarFileInput || !avatarUploadBtn) return
  if (!currentProfileId || !currentProfileId.startsWith('@')) {
    status.set('avatar', 'Select your profile first', 'warn', { timeout: 4000 })
    return
  }
  if (!browserKeys || !currentFeedId) {
    status.set('avatar', 'Browser keys not ready', 'error', { timeout: 4000 })
    return
  }
  const file = avatarFileInput.files && avatarFileInput.files[0]
  if (!file) {
    status.set('avatar', 'Choose an image to upload', 'warn', { timeout: 4000 })
    return
  }
  avatarUploadBtn.disabled = true
  try {
    status.set('avatar', 'Preparing image…')
    const processed = await prepareAvatarBlob(file)
    status.set('avatar', 'Uploading avatar…')
    const hash = await uploadAvatarBlob(processed)
    await publishContentUpdate(
      { type: 'about', about: currentProfileId, image: { link: hash, type: processed.type, size: processed.size } },
      {
        statusKey: 'avatar',
        progressLabel: 'Updating avatar…',
        queuedLabel: seq => 'Queued avatar #' + seq,
        successLabel: 'Avatar updated',
        offlineLabel: 'Offline: avatar will sync soon'
      }
    )
  } catch (err) {
    console.error('avatar upload failed', err)
    status.set('avatar', 'Avatar upload failed: ' + err.message, 'error', { timeout: 6000 })
  } finally {
    avatarUploadBtn.disabled = false
    if (avatarFileInput) avatarFileInput.value = ''
  }
}

async function saveProfileDisplayName() {
  if (!profileNameInput || !profileSaveBtn) return
  if (!currentProfileId || !currentProfileId.startsWith('@')) {
    status.set('profile', 'Select a profile first', 'warn', { timeout: 4000 })
    return
  }
  const raw = profileNameInput.value.trim()
  if (!raw) {
    status.set('profile', 'Enter a display name', 'warn', { timeout: 4000 })
    profileNameInput.focus()
    return
  }
  if (!browserKeys || !currentFeedId) {
    status.set('profile', 'Browser keys not ready', 'error', { timeout: 4000 })
    return
  }
  profileNameInput.value = raw
  profileSaveBtn.disabled = true
  try {
    await publishContentUpdate(
      { type: 'about', about: currentProfileId, name: raw },
      {
        statusKey: 'profile',
        progressLabel: 'Updating display name…',
        queuedLabel: seq => 'Queued update #' + seq,
        successLabel: 'Display name updated',
        offlineLabel: 'Offline: will sync display name soon'
      }
    )
  } catch (err) {
    console.error('failed to update display name', err)
    status.set('profile', 'Failed to update name: ' + err.message, 'error', { timeout: 6000 })
  } finally {
    profileSaveBtn.disabled = false
  }
}

async function publishText() {
  const text = composeEl && composeEl.value
  if (!text) return
  if (!browserKeys || !currentFeedId) {
    status.set('publish', 'Browser keys not ready', 'error', { timeout: 4000 })
    return
  }
  publishBtn.disabled = true
  status.set('publish', 'Publishing…')
  try {
    const msg = await buildSignedMessage({ type: 'post', text: text })
    const entry = await createLocalEntryFromSigned(msg)
    if (composeEl) composeEl.value = ''
    applyEntry(entry)
    await persistEntry(entry)
    await queuePendingMessage(entry, msg)
    status.set('publish', 'Queued entry #' + entry.value.sequence, 'info', { timeout: 3000 })
    try {
      const serverEntry = await postSignedMessage(msg)
      await persistEntry(serverEntry)
      await removePendingMessage(entry.key)
      if (!entryCache[serverEntry.key]) {
        applyEntry(serverEntry)
      }
      status.set('publish', 'Published entry #' + serverEntry.value.sequence, 'success', { timeout: 4000 })
    } catch (err) {
      console.warn('publish deferred for offline sync', err)
      status.set('publish', 'Offline: queued entry #' + entry.value.sequence, 'warn', { timeout: 5000 })
      scheduleFlushRetry()
    }
  } catch (err) {
    console.error('publish failed', err)
    status.set('publish', 'Publish failed: ' + err.message, 'error', { timeout: 6000 })
  } finally {
    publishBtn.disabled = false
  }
}

if (publishBtn && composeEl) {
  publishBtn.addEventListener('click', publishText)
}

if (profileSaveBtn && profileNameInput) {
  profileSaveBtn.addEventListener('click', saveProfileDisplayName)
  profileNameInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault()
      saveProfileDisplayName()
    }
  })
}

if (followBtn) {
  followBtn.addEventListener('click', () => {
    if (!currentProfileId || !currentProfileId.startsWith('@')) return
    publishContactUpdate(currentProfileId, true)
  })
}

if (unfollowBtn) {
  unfollowBtn.addEventListener('click', () => {
    if (!currentProfileId || !currentProfileId.startsWith('@')) return
    publishContactUpdate(currentProfileId, false)
  })
}

if (avatarUploadBtn && avatarFileInput) {
  avatarUploadBtn.addEventListener('click', uploadAvatarImage)
  avatarFileInput.addEventListener('change', () => {
    if (avatarFileInput.files && avatarFileInput.files[0]) {
      status.set('avatar', 'Selected ' + avatarFileInput.files[0].name, 'info', { timeout: 2000 })
    }
  })
}

if (deleteBtn) {
  deleteBtn.addEventListener('click', wipeLocalCache)
}

window.addEventListener('online', () => {
  status.set('connection', 'Online, syncing…', 'info', { timeout: 4000 })
  flushPendingQueue()
  loadFeed()
})

window.addEventListener('offline', () => {
  status.set('connection', 'Offline mode; entries will sync later', 'warn')
})

if (!window.location.hash) {
  window.location.hash = '#'
}
handleRouteChange()
window.addEventListener('hashchange', handleRouteChange)

ensureBrowserKeys()
  .then(async () => {
    await loadLocalFeed()
    loadFeed()
    startSocket()
    flushPendingQueue()
  })
  .catch(err => {
    status.set('init', 'Failed to initialize keys: ' + err.message, 'error')
  })
