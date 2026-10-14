/**
 * dsh-wallpaper-rotation — host half.
 *
 * Serves three resources for the WebUI client:
 *   GET  /plugins/dsh-wallpaper-rotation/manifest      — grouped wallpaper listing
 *   GET  /plugins/dsh-wallpaper-rotation/image?path=<rel> — one image's bytes
 *   GET  /plugins/dsh-wallpaper-rotation/config        — current configuration
 *   PATCH /plugins/dsh-wallpaper-rotation/config       — live configuration update
 *
 * The configured folder is scanned into three groups: files directly in the
 * root are shared between themes, while the `light/` and `dark/` subfolders
 * map to the light and dark UI themes respectively. All routes are loopback
 * only; writes additionally require a same-origin `Origin` header.
 *
 * Configuration lives in this plugin's Loader entry — the row this bundle's
 * cordis.patch.yml inserts, whose values the profile patch in
 * `$DSH_HOME/profiles/<profile>/cordis.patch.yml` carries. Two 0.1.7 contracts
 * follow from that, and both are load-bearing:
 *
 *   - Every writable field is marked `.volatile()`. `ctx.settings.update`
 *     refuses a namespace whose schema has no volatile field
 *     ("Plugin entry ... has no volatile fields"), so without the marker no
 *     user edit could ever be written back. The plugin would still run; it
 *     would just quietly forget everything on restart.
 *   - A volatile field reaches the plugin as a Ref (`{ get() }`), not as a
 *     plain value — that indirection is what lets the settings service edit the
 *     field in place, without remounting the plugin. Every read goes through
 *     `.get()`, which also means reads are live: no cache, no subscription.
 *
 * Writes go through `ctx.settings.update`, which deep-merges into the entry's
 * current user layer and persists it through the config editor. `replace` would
 * be wrong here: it resets every live field to its inherited value before
 * applying the supplied ones, so the card's one-field PATCH would wipe the
 * other four.
 *
 * Original implementation. Uses only the public DSH plugin contract
 * (cordis services `webServer` and `settings`, schemastery config schema).
 */
import Schema from '@deepseek-ai/schemastery'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'

export const name = 'dsh-wallpaper-rotation'
export const inject = ['webServer', 'settings']

/** This plugin's Loader entry id — the namespace `ctx.settings` addresses. */
const NS = 'dsh-wallpaper-rotation'

export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('启用壁纸轮换').volatile(),
  folder: Schema.string().default('').description('壁纸根文件夹（首次使用需配置）：light/ 与 dark/ 子目录分别对应亮/暗主题，根目录文件为通用壁纸').volatile(),
  intervalMinutes: Schema.number().min(1).max(240).step(1).default(5).description('轮换间隔（分钟）').volatile(),
  opacity: Schema.number().min(0.1).max(1).step(0.05).default(1).description('壁纸不透明度').volatile(),
  'bg-base': Schema.number().min(0).max(1).step(0.05).default(0).description('对话区背景 (--dsw-alias-bg-base)；侧边栏 (--dsw-specific-sidebar-fill) 固定为 10%').volatile(),
}).description('壁纸轮换：本地图片定时轮换，亮/暗主题各一组壁纸')

const defaults = Object.freeze({
  enabled: true,
  folder: '',
  intervalMinutes: 5,
  opacity: 1,
  'bg-base': 0,
})

const BASE_PATH = `/plugins/${NS}`

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif'])
const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
}

/**
 * Read one Config field, which a `.volatile()` declaration delivers as a Ref.
 * Reading a Ref as a plain value yields the Ref object itself, not the setting;
 * calling `.get()` on every access is what keeps the value live after an edit.
 */
function readField(field, fallback) {
  const value = field !== null && typeof field === 'object' && typeof field.get === 'function'
    ? field.get()
    : field
  return value === undefined || value === null ? fallback : value
}

/** Narrow the live config to the public shape (unknown fields dropped). */
function publicConfig(config = {}) {
  return {
    enabled: readField(config.enabled, defaults.enabled),
    folder: readField(config.folder, defaults.folder),
    intervalMinutes: readField(config.intervalMinutes, defaults.intervalMinutes),
    opacity: readField(config.opacity, defaults.opacity),
    'bg-base': readField(config['bg-base'], defaults['bg-base']),
  }
}

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Sorted image filenames of one directory; empty when the directory is missing. */
function listImages(dir) {
  try {
    return readdirSync(dir)
      .filter((file) => IMAGE_EXTS.has(extname(file).toLowerCase()))
      .sort()
  } catch {
    return []
  }
}

/** Scan the configured root into the light/dark/shared groups. */
function scanManifest(root) {
  const groups = { light: [], dark: [], shared: [] }
  if (!root || !existsSync(root)) return groups
  for (const file of listImages(root)) groups.shared.push(file)
  for (const group of ['light', 'dark']) {
    for (const file of listImages(join(root, group))) {
      groups[group].push(`${group}/${file}`)
    }
  }
  return groups
}

/**
 * Resolve a manifest-relative path inside the root; undefined when the path is
 * unsafe (traversal, absolute, NUL) or does not point to a file.
 */
function resolveImage(root, rel) {
  if (!rel || rel.includes('\0') || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return undefined
  const base = resolve(root)
  const target = resolve(base, rel)
  if (target !== base && !target.startsWith(base + sep)) return undefined
  try {
    if (!statSync(target).isFile()) return undefined
  } catch {
    return undefined
  }
  return target
}

function mount(ctx, config = {}) {
  const logger = ctx.logger ?? console
  // Reads are live: `config` holds the Loader entry's Config refs, and a
  // settings edit updates those refs in place rather than remounting us.
  const current = () => publicConfig(config)

  const sendConfig = (res) => json(res, 200, current())

  const readPatch = async (req) => {
    const chunks = []
    let bytes = 0
    for await (const chunk of req) {
      bytes += chunk.length
      if (bytes > 16384) throw new Error('request body too large')
      chunks.push(chunk)
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('patch must be an object')
    }
    const types = {
      enabled: 'boolean',
      folder: 'string',
      intervalMinutes: 'number',
      opacity: 'number',
      'bg-base': 'number',
    }
    for (const [key, next] of Object.entries(value)) {
      if (!(key in types)) throw new Error(`unknown setting: ${key}`)
      if (typeof next !== types[key]) throw new Error(`${key} must be a ${types[key]}`)
    }
    return value
  }

  const handleConfig = async (req, res) => {
    if (!isLoopback(req.socket?.remoteAddress)) {
      json(res, 403, { error: 'local access only' })
      return
    }
    if (req.method === 'GET') return sendConfig(res)
    if (req.method !== 'PATCH') return json(res, 405, { error: 'method not allowed' })
    const origin = req.headers?.origin
    if (origin) {
      let originHost
      try {
        originHost = new URL(origin).host
      } catch {
        /* malformed origin — treated as mismatch below */
      }
      if (!originHost || originHost !== req.headers.host) {
        json(res, 403, { error: 'origin mismatch' })
        return
      }
    }
    try {
      const patch = await readPatch(req)
      // Merge into the entry's user layer and persist it. Throws loudly when the
      // namespace is not editable, rather than pretending the write succeeded.
      await ctx.settings.update(NS, patch)
      return sendConfig(res)
    } catch (error) {
      return json(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  const handleManifest = (req, res) => {
    if (!isLoopback(req.socket?.remoteAddress)) {
      json(res, 403, { error: 'local access only' })
      return
    }
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
    return json(res, 200, scanManifest(current().folder))
  }

  const handleImage = (req, res) => {
    if (!isLoopback(req.socket?.remoteAddress)) {
      json(res, 403, { error: 'local access only' })
      return
    }
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
    let url
    try {
      url = new URL(req.url ?? '/', 'http://dsh.local')
    } catch {
      json(res, 400, { error: 'bad url' })
      return
    }
    const rel = url.searchParams.get('path') ?? ''
    const file = resolveImage(current().folder, rel)
    if (file === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    try {
      const body = readFileSync(file)
      const type = MIME_BY_EXT[extname(file).toLowerCase()] ?? 'application/octet-stream'
      res.writeHead(200, {
        'content-type': type,
        'cache-control': 'public, max-age=3600',
        'content-length': body.length,
      })
      res.end(body)
    } catch {
      res.writeHead(404)
      res.end()
    }
  }

  // Three exact routes (not a prefix): the client-modules bundle route lives
  // under /plugins/<id>/client.js via its own prefix, and a prefix here would
  // shadow it (longest-prefix-wins) and 404 the browser bundle.
  const disposers = [
    ctx.webServer.register({ kind: 'exact', path: `${BASE_PATH}/config`, handler: handleConfig }),
    ctx.webServer.register({ kind: 'exact', path: `${BASE_PATH}/manifest`, handler: handleManifest }),
    ctx.webServer.register({ kind: 'exact', path: `${BASE_PATH}/image`, handler: handleImage }),
  ]
  logger.info(`[${NS}] host mounted (opacity ${current().opacity})`)
  return () => {
    for (const dispose of disposers) dispose()
  }
}

export function apply(ctx, config = {}) {
  ctx.effect(() => mount(ctx, config), 'dsh-wallpaper-rotation: web routes')
}
