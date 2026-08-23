/**
 * dsh-wallpaper-rotation — browser client bundle.
 *
 * Original implementation. Creates its own fixed wallpaper layer as the first
 * child of the app frame (anchored through the stable `[data-shell-overlay]`
 * marker), makes the main surfaces translucent by overriding the two surface
 * tokens on <body> (pristine values are cached per theme so slider drags are
 * cheap), rotates through the active theme's wallpaper group on a timer, and
 * switches groups instantly when `body[data-ds-dark-theme]` flips.
 *
 * Config changes are applied locally and instantly (opacity + surfaces only —
 * the wallpaper image is never re-rendered by a config change), then
 * persisted through the host config endpoint. Manifest changes (folder or
 * rescan) are the only thing that re-renders the wallpaper.
 *
 * Settings live in a card registered into the `settings.plugin.item` slot.
 */
window.__ModuleLoader__.load({ id: 'dsh-wallpaper-rotation', factory: (require) => {
  const module = { exports: {} }
  const exports = module.exports
  const React = require('react')
  const { useEffect, useRef, useState } = React

  const BASE = '/plugins/dsh-wallpaper-rotation'
  const CONFIG_URL = `${BASE}/config`
  const MANIFEST_URL = `${BASE}/manifest`
  const IMAGE_URL = `${BASE}/image?path=`
  const DARK_ATTR = 'data-ds-dark-theme'
  const CHANGE_EVENT = 'dsh-wallpaper-rotation:changed'
  const MANIFEST_EVENT = 'dsh-wallpaper-rotation:manifest'
  const CROSSFADE_MS = 600
  const FRAME_ANCHOR = '[data-shell-overlay]'

  // ---------- shared helpers ----------

  const readJson = async (url) => {
    const response = await fetch(url, { cache: 'no-store' })
    if (!response.ok) throw new Error(`request failed: ${response.status}`)
    return response.json()
  }

  const isDark = () => document.body.hasAttribute(DARK_ATTR)
  const mix = (color, alpha) => `color-mix(in srgb, ${color} ${Math.round(alpha * 100)}%, transparent)`
  const computed = (name) => getComputedStyle(document.body).getPropertyValue(name).trim()

  /** The surface token this plugin can make translucent, keyed by config field. */
  const SURFACE_TOKENS = {
    'bg-base': '--dsw-alias-bg-base',
  }
  /** The sidebar fill is fixed at 10% (very translucent) per the final design. */
  const SIDEBAR_TOKEN = '--dsw-specific-sidebar-fill'
  const SIDEBAR_ALPHA = 0.1

  /** Remove every surface override so pristine (per-theme) values can be read again. */
  function clearSurfaces() {
    const style = document.body.style
    for (const token of Object.values(SURFACE_TOKENS)) style.removeProperty(token)
    style.removeProperty(SIDEBAR_TOKEN)
  }

  /** Pristine token values per theme, cached so repeated applies are cheap. */
  const tokenCache = new Map() // token -> { light: string, dark: string }
  function pristineValue(token) {
    const key = isDark() ? 'dark' : 'light'
    let entry = tokenCache.get(token)
    if (entry === undefined) {
      entry = {}
      tokenCache.set(token, entry)
    }
    if (entry[key] === undefined) {
      document.body.style.removeProperty(token)
      entry[key] = computed(token)
    }
    return entry[key]
  }
  function invalidateTokens() {
    tokenCache.clear()
  }

  /**
   * Apply the conversation background translucency (--dsw-alias-bg-base,
   * slider-controlled), the fixed sidebar translucency (--dsw-specific-
   * sidebar-fill at 10%), and the wallpaper opacity. When disabled, every
   * surface override is removed (back to stock opaque) and the wallpaper
   * layer is hidden. Pure CSS work — never touches the wallpaper image.
   */
  function applySurfaceConfig(cfg) {
    const wrapper = document.querySelector('[data-wallpaper-rotation]')
    if (cfg.enabled === false) {
      clearSurfaces()
      if (wrapper !== null) wrapper.style.display = 'none'
      return
    }
    for (const [field, token] of Object.entries(SURFACE_TOKENS)) {
      const alpha = cfg[field] ?? 0
      if (alpha >= 1) {
        document.body.style.removeProperty(token)
      } else {
        const color = pristineValue(token)
        if (color) document.body.style.setProperty(token, mix(color, Math.max(0, alpha)))
      }
    }
    const sidebar = pristineValue(SIDEBAR_TOKEN)
    if (sidebar) document.body.style.setProperty(SIDEBAR_TOKEN, mix(sidebar, SIDEBAR_ALPHA))
    if (wrapper !== null) {
      wrapper.style.display = ''
      wrapper.style.opacity = String(cfg.opacity ?? 1)
    }
  }

  // ---------- wallpaper engine ----------

  function createEngine() {
    let cfg = null
    let manifest = { light: [], dark: [], shared: [] }
    let folder = null
    let dark = isDark()
    let index = 0
    let timer = null
    let pollTimer = null
    let observer = null
    let started = false
    let wrapper = null
    let layers = null
    let visible = 0

    const group = () => (dark ? manifest.dark : manifest.light)
    const pick = () => {
      let list = group()
      if (!list || list.length === 0) list = manifest.shared
      if (!list || list.length === 0) list = dark ? manifest.light : manifest.dark
      return list ?? []
    }
    const imageUrl = (rel) => `${IMAGE_URL}${encodeURIComponent(rel)}`

    const preload = (src) => new Promise((done) => {
      const img = new Image()
      img.onload = () => done(true)
      img.onerror = () => done(false)
      img.src = src
    })

    async function showNext(list) {
      if (wrapper === null || !list.length) return
      const rel = list[index % list.length]
      const src = imageUrl(rel)
      const incoming = layers[1 - visible]
      if (await preload(src)) {
        incoming.style.backgroundImage = `url("${src}")`
        incoming.style.opacity = '1'
        layers[visible].style.opacity = '0'
        visible = 1 - visible
      }
    }

    function schedule() {
      if (timer !== null) clearTimeout(timer)
      const minutes = Math.max(1, cfg?.intervalMinutes ?? 5)
      timer = setTimeout(() => {
        if (cfg?.enabled === false) return
        const list = pick()
        index = (index + 1) % Math.max(1, list.length)
        void showNext(list)
        schedule()
      }, minutes * 60 * 1000)
    }

    /** Render the current theme group's image (fade in). Only called on theme/manifest changes. */
    function render() {
      if (wrapper === null) return
      const enabled = cfg?.enabled !== false
      wrapper.style.display = enabled ? '' : 'none'
      if (enabled) void showNext(pick())
    }

    function ensureLayer() {
      if (wrapper !== null) return true
      const frame = document.querySelector(FRAME_ANCHOR)?.parentElement
      if (!frame) return false
      wrapper = document.createElement('div')
      wrapper.setAttribute('data-wallpaper-rotation', '')
      wrapper.style.cssText = 'position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden;opacity:1'
      layers = [document.createElement('div'), document.createElement('div')]
      for (const layer of layers) {
        layer.style.cssText = `position:absolute;inset:0;background-repeat:no-repeat;background-position:center;background-size:cover;opacity:0;transition:opacity ${CROSSFADE_MS}ms ease-in-out`
        wrapper.appendChild(layer)
      }
      layers[visible].style.opacity = '1'
      frame.insertBefore(wrapper, frame.firstChild)
      return true
    }

    /** Boot: fetch config + manifest, apply everything, start rotation. */
    function boot() {
      return Promise.all([readJson(CONFIG_URL), readJson(MANIFEST_URL)])
        .then(([nextCfg, nextManifest]) => {
          cfg = nextCfg
          folder = nextCfg.folder
          manifest = nextManifest ?? { light: [], dark: [], shared: [] }
          applySurfaceConfig(cfg)
          index = 0
          render()
          schedule()
        })
        .catch(() => { /* keep previous working state */ })
    }

    /** Config event: apply opacity/surfaces live; re-render only when the folder changed. */
    function onConfigChanged() {
      return readJson(CONFIG_URL)
        .then((nextCfg) => {
          const folderChanged = nextCfg.folder !== folder
          cfg = nextCfg
          folder = nextCfg.folder
          applySurfaceConfig(cfg)
          if (folderChanged) {
            return readJson(MANIFEST_URL).then((nextManifest) => {
              manifest = nextManifest ?? { light: [], dark: [], shared: [] }
              index = 0
              render()
            })
          }
          schedule()
        })
        .catch(() => { /* keep previous state */ })
    }

    /** Manifest event (rescan button / folder commit): reload listing + render. */
    function refreshManifest() {
      return readJson(MANIFEST_URL)
        .then((nextManifest) => {
          manifest = nextManifest ?? { light: [], dark: [], shared: [] }
          index = 0
          render()
        })
        .catch(() => { /* keep previous state */ })
    }

    function onThemeChange() {
      dark = isDark()
      invalidateTokens()
      applySurfaceConfig(cfg ?? {})
      index = 0
      render()
    }

    function start() {
      if (started) return
      started = true
      const tick = () => {
        if (ensureLayer()) {
          clearInterval(pollTimer)
          pollTimer = null
          void boot()
        }
      }
      pollTimer = setInterval(tick, 250)
      tick()
      observer = new MutationObserver(onThemeChange)
      observer.observe(document.body, { attributes: true, attributeFilter: [DARK_ATTR] })
      window.addEventListener(CHANGE_EVENT, onConfigChanged)
      window.addEventListener(MANIFEST_EVENT, refreshManifest)
    }

    function stop() {
      started = false
      if (pollTimer !== null) clearInterval(pollTimer)
      pollTimer = null
      if (timer !== null) clearTimeout(timer)
      timer = null
      observer?.disconnect()
      observer = null
      window.removeEventListener(CHANGE_EVENT, onConfigChanged)
      window.removeEventListener(MANIFEST_EVENT, refreshManifest)
      wrapper?.remove()
      wrapper = null
      layers = null
      clearSurfaces()
    }

    return { start, stop }
  }

  // ---------- settings card ----------

  const cardStyle = {
    listStyle: 'none', border: '1px solid var(--border-color, #d8d8d8)', borderRadius: 12,
    padding: 16, background: 'var(--surface-color, transparent)', display: 'grid', gap: 12,
  }
  const rowStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }
  const textStyle = { flex: 1, minWidth: 0, padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border-color, #d8d8d8)', background: 'var(--input-color, transparent)' }
  const inputStyle = { minWidth: 120, padding: '6px 10px', borderRadius: 8 }

  function Field({ label, hint, children }) {
    return React.createElement('label', { style: rowStyle },
      React.createElement('span', null,
        React.createElement('span', { style: { display: 'block', fontWeight: 600 } }, label),
        hint ? React.createElement('small', { style: { display: 'block', opacity: 0.65, marginTop: 2 } }, hint) : null,
      ),
      children,
    )
  }

  function SettingsCard() {
    const [status, setStatus] = useState('loading')
    const [value, setValue] = useState({})
    const [counts, setCounts] = useState(null)
    const [folderDraft, setFolderDraft] = useState('')
    const [intervalDraft, setIntervalDraft] = useState('5')
    const timers = useRef(new Map())
    const seq = useRef(0)

    const load = (active = true) => {
      return Promise.all([readJson(CONFIG_URL), readJson(MANIFEST_URL)])
        .then(([cfg, man]) => {
          if (!active) return
          setValue(cfg)
          setFolderDraft(cfg.folder ?? '')
          setIntervalDraft(String(cfg.intervalMinutes ?? 5))
          setCounts({ light: man.light.length, dark: man.dark.length, shared: man.shared.length })
          setStatus('ready')
        })
        .catch(() => { if (active) setStatus('unavailable') })
    }

    useEffect(() => {
      let active = true
      void load(active)
      return () => {
        active = false
        for (const pending of timers.current.values()) clearTimeout(pending)
        timers.current.clear()
      }
    }, [])

    /**
     * Persist one field change: apply the effect locally IMMEDIATELY (smooth),
     * then send one debounced PATCH; the server response reconciles the value.
     */
    const patch = (field, next) => {
      const mine = ++seq.current
      const nextValue = { ...value, [field]: next }
      setValue(nextValue)
      applySurfaceConfig(nextValue)
      const pending = timers.current.get(field)
      if (pending) clearTimeout(pending)
      timers.current.set(field, setTimeout(() => {
        timers.current.delete(field)
        fetch(CONFIG_URL, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ [field]: next }),
        })
          .then(async (response) => {
            if (!response.ok) throw new Error(`write failed: ${response.status}`)
            const updated = await response.json()
            if (mine === seq.current) setValue(updated)
            window.dispatchEvent(new CustomEvent(CHANGE_EVENT))
          })
          .catch(() => { if (mine === seq.current) setStatus('unavailable') })
      }, 250))
    }

    const commitFolder = () => {
      const next = folderDraft.trim()
      if (next && next !== value.folder) {
        patch('folder', next)
        window.dispatchEvent(new CustomEvent(MANIFEST_EVENT))
      }
    }

    const commitInterval = () => {
      const n = Number(intervalDraft)
      if (Number.isFinite(n) && n >= 1 && n !== value.intervalMinutes) {
        patch('intervalMinutes', Math.min(240, Math.round(n)))
      } else {
        setIntervalDraft(String(value.intervalMinutes ?? 5))
      }
    }

    const rescan = () => {
      setStatus('loading')
      readJson(MANIFEST_URL)
        .then((man) => {
          setCounts({ light: man.light.length, dark: man.dark.length, shared: man.shared.length })
          setStatus('ready')
          window.dispatchEvent(new CustomEvent(MANIFEST_EVENT))
        })
        .catch(() => setStatus('unavailable'))
    }

    const ready = status === 'ready'
    const slider = (field, min, max, label, hint) =>
      Field({ label, hint,
        children: React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          React.createElement('input', {
            type: 'range', min, max, step: 0.05,
            value: value[field] ?? min, disabled: !ready,
            onChange: (event) => patch(field, Number(event.target.value)),
          }),
          React.createElement('span', { style: { minWidth: 42, textAlign: 'right', fontVariantNumeric: 'tabular-nums' } },
            `${Math.round((value[field] ?? min) * 100)}%`),
        ),
      })

    return React.createElement('li', { style: cardStyle, 'data-testid': 'dsh-wallpaper-rotation-settings' },
      React.createElement('div', null,
        React.createElement('strong', { style: { fontSize: 16 } }, '壁纸轮换'),
        React.createElement('p', { style: { margin: '4px 0 0', opacity: 0.72 } },
          counts
            ? `亮 ${counts.light} 张 · 暗 ${counts.dark} 张 · 通用 ${counts.shared} 张`
            : '多张图片定时轮换，亮/暗主题各一组壁纸。'),
      ),
      status === 'unavailable'
        ? React.createElement('span', { role: 'status' }, '设置尚未连接到 DSH Host。')
        : status === 'loading'
        ? React.createElement('span', null, '正在读取设置…')
        : React.createElement(React.Fragment, null,
          Field({ label: '壁纸开关', hint: '关闭后壁纸隐藏，界面恢复默认纯色背景（无半透明）。',
            children: React.createElement('input', {
              type: 'checkbox', checked: value.enabled !== false, disabled: !ready,
              onChange: (event) => patch('enabled', event.target.checked),
            }) }),
          Field({ label: '壁纸文件夹', hint: 'light/ 与 dark/ 子目录分别对应亮/暗主题，根目录文件为通用；回车或失焦保存。',
            children: React.createElement('input', {
              type: 'text', style: textStyle, value: folderDraft, disabled: !ready,
              onChange: (event) => setFolderDraft(event.target.value),
              onBlur: commitFolder,
              onKeyDown: (event) => { if (event.key === 'Enter') commitFolder() },
            }) }),
          Field({ label: '轮换间隔（分钟）', hint: '每张壁纸停留时长；回车或失焦保存。',
            children: React.createElement('input', {
              type: 'number', min: 1, max: 240, style: inputStyle, disabled: !ready,
              value: intervalDraft,
              onChange: (event) => setIntervalDraft(event.target.value),
              onBlur: commitInterval,
              onKeyDown: (event) => { if (event.key === 'Enter') commitInterval() },
            }) }),
          slider('opacity', 0.1, 1, '壁纸不透明度', '壁纸层的浓淡。'),
          slider('bg-base', 0, 1, '对话区背景', '--dsw-alias-bg-base；侧边栏固定 10%'),
          Field({ label: '', hint: '',
            children: React.createElement('button', {
              style: { padding: '6px 14px', borderRadius: 8, cursor: 'pointer' },
              onClick: rescan, disabled: !ready,
            }, '重新扫描文件夹') }),
        ),
    )
  }

  // ---------- plugin face ----------

  function apply(ctx) {
    const engine = createEngine()
    ctx.effect(() => {
      engine.start()
      return () => engine.stop()
    }, 'dsh-wallpaper-rotation: engine')
    ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
      name: 'settings.plugin.item',
      id: 'dsh-wallpaper-rotation',
      key: 'dsh-wallpaper-rotation',
      order: 40,
      inject: () => ({}),
    }, SettingsCard))
  }

  module.exports = {
    name: 'dsh-wallpaper-rotation-client',
    inject: ['slots'],
    apply,
  }
  return module.exports
} })
