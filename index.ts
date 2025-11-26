import type { Plugin, ViteDevServer } from 'vite'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import pc from 'picocolors'

type Options = {
    /** Caddy Admin API base URL */
    adminUrl?: string // default 'http://127.0.0.1:2019'
    /** Caddy apps.http server id to use/create */
    serverId?: string // default 'vite-dev'
    /** Addresses for the dev server we manage in Caddy */
    listen?: string[] // default [':80']
    /**
     * Choose the subdomain source (before the TLD) when no explicit `domain` is given:
     *    - 'folder' (default): use current folder name
     *    - 'pkg': use package.json "name"
     */
    nameSource?: 'folder' | 'pkg'
    /** Top-level domain (TLD) to use when building the domain (ignored if `domain` is set) */
    tld?: string // default 'local'
    /**
     * Fully explicit domain to use (e.g., 'myapp.local' or 'myapp.localhost').
     * If provided, overrides nameSource+tld.
     */
    domain?: string
    /**
     * If an existing domain points to an active port that is NOT the current Vite port:
     *    - true (default): fail fast & explain
     *    - false: leave it alone and continue (no changes)
     */
    failOnActiveDomain?: boolean
    /**
     * Insert the route at index 0 (before others) when creating a new one.
     * Default: true
     */
    insertFirst?: boolean
    /** Print logs. Default: true */
    verbose?: boolean
}

export default function domain(user: Options = {}): Plugin {
    const opt: Required<Omit<Options, 'domain'>> & { domain?: string } = {
        adminUrl: user.adminUrl ?? 'http://127.0.0.1:2019',
        serverId: user.serverId ?? 'vite-dev',
        listen: user.listen ?? [':443', ':80'],
        nameSource: user.nameSource ?? 'folder',
        tld: user.tld ?? 'local',
        domain: user.domain,
        failOnActiveDomain: user.failOnActiveDomain ?? true,
        insertFirst: user.insertFirst ?? true,
        verbose: user.verbose ?? false,
    }

    const log = (...args: unknown[]) => {
        if (opt.verbose) console.log('[vite-plugin-domain]', ...args)
    }
    const warn = (...args: unknown[]) => console.warn('[vite-plugin-domain]', ...args)
    const err = (...args: unknown[]) => console.error('[vite-plugin-domain]', ...args)

    // ---------- HTTP helpers ----------
    async function req(url: string, init?: RequestInit) {
        const r = await fetch(url, init)
        const txt = await r.text()
        if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText} for ${url}\n${txt}`)
        return txt ? JSON.parse(txt) : undefined
    }
    async function get<T = unknown>(url: string): Promise<T | undefined> {
        const r = await fetch(url)
        if (!r.ok) return undefined
        const t = await r.text()
        return t ? (JSON.parse(t) as T) : (undefined as T | undefined)
    }
    const post = (url: string, body: unknown) =>
        req(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        })
    const put = (url: string, body: unknown) =>
        req(url, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        })
    const del = async (url: string) => {
        const r = await fetch(url, { method: 'DELETE' })
        if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText} for ${url}\n${await r.text()}`)
    }

    // ---------- Domain helpers ----------
    function slugFromFolder(): string {
        return path
            .basename(process.cwd())
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, '-')
            .replace(/^-+|-+$/g, '')
    }
    function slugFromPkg(): string {
        try {
            const pkg = JSON.parse(
                fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'),
            )
            const name = typeof pkg.name === 'string' ? pkg.name : slugFromFolder()
            return String(name)
                .toLowerCase()
                .replace(/[^a-z0-9-]+/g, '-')
                .replace(/^-+|-+$/g, '')
        } catch {
            return slugFromFolder()
        }
    }
    function computeDomain(): string {
        const env = process.env.VITE_PLUGIN_DOMAIN_VALUE?.trim().toLowerCase()
        if (env) return env
        if (opt.domain) return opt.domain
        const base = opt.nameSource === 'pkg' ? slugFromPkg() : slugFromFolder()
        return `${base}.${opt.tld}`
    }

    // ---------- Caddy bootstrap (HTTPS-first) ----------
    async function ensureCaddyServerExists(domain: string) {
        // If root config is null, seed both http+tls apps with internal issuer policy for this domain.
        const root = await get(`${opt.adminUrl}/config/`)
        if (root == null) {
            await post(`${opt.adminUrl}/load`, {
                apps: {
                    http: {
                        servers: {
                            [opt.serverId]: {
                                listen: opt.listen,
                                routes: [],
                            },
                        },
                    },
                    tls: {
                        automation: {
                            policies: [
                                {
                                    subjects: [domain],
                                    issuers: [{ module: 'internal' }],
                                },
                            ],
                        },
                    },
                },
            })
            log(
                `Initialized Caddy config; server '${opt.serverId}' on ${opt.listen.join(', ')}; TLS internal for ${domain}`,
            )
            return
        }

        // Ensure server exists (and listens on desired ports)
        const serverBase = `${opt.adminUrl}/config/apps/http/servers/${encodeURIComponent(opt.serverId)}`
        const haveServer = await fetch(serverBase, { method: 'GET' })
        if (!haveServer.ok) {
            // Create parents as needed, then server
            const ensurePath = async (p: string, payload: unknown) => {
                const r = await fetch(p, { method: 'GET' })
                if (!r.ok) await put(p, payload)
            }
            await ensurePath(`${opt.adminUrl}/config/apps`, {})
            await ensurePath(`${opt.adminUrl}/config/apps/http`, { servers: {} })
            await ensurePath(`${opt.adminUrl}/config/apps/http/servers`, {})
            await put(serverBase, { listen: opt.listen, routes: [] })
            log(`Created server '${opt.serverId}' on ${opt.listen.join(', ')}`)
        } else {
            // Make sure desired ports are present
            const listenPath = `${serverBase}/listen`
            const current: string[] | undefined = await get(listenPath)
            const want = new Set(opt.listen)
            const next = Array.from(new Set([...(current ?? []), ...want]))
            if (!arraysEqual(current ?? [], next)) {
                await put(listenPath, next)
                log(`Updated '${opt.serverId}' listen → ${next.join(', ')}`)
            }
            // If automatic_https was previously disabled, re-enable by clearing/setting flag
            const autoPath = `${serverBase}/automatic_https`
            const auto: any = await get(autoPath)
            if (auto?.disable === true) {
                await put(autoPath, { ...auto, disable: false })
                log(`Re-enabled automatic HTTPS on '${opt.serverId}'`)
            }
        }

        // Ensure TLS automation policy (internal issuer) exists for this domain
        await ensureTlsPolicy(domain)
    }

    async function ensureTlsPolicy(domain: string) {
        const ensurePath = async (p: string, payload: unknown) => {
            const r = await fetch(p, { method: 'GET' })
            if (!r.ok) await put(p, payload)
        }
        await ensurePath(`${opt.adminUrl}/config/apps`, {})
        // Create bare tls app if needed (non-destructive to other apps)
        const tlsPath = `${opt.adminUrl}/config/apps/tls`
        const haveTls = await fetch(tlsPath, { method: 'GET' })
        if (!haveTls.ok) {
            await put(tlsPath, { automation: { policies: [] } })
        } else {
            // ensure automation/policies containers exist
            const autoPath = `${tlsPath}/automation`
            const auto = await fetch(autoPath, { method: 'GET' })
            if (!auto.ok) await put(autoPath, { policies: [] })
            const polPath = `${autoPath}/policies`
            const pol = await fetch(polPath, { method: 'GET' })
            if (!pol.ok) await put(polPath, []) // initialize array
        }

        // Check for an existing internal-policy that covers this exact domain
        const policies: any[] =
            (await get(`${opt.adminUrl}/config/apps/tls/automation/policies`)) ?? []
        const idx = policies.findIndex(
            p =>
                Array.isArray(p?.subjects) &&
                p.subjects.includes(domain) &&
                Array.isArray(p?.issuers) &&
                p.issuers.some((i: any) => i?.module === 'internal'),
        )

        if (idx === -1) {
            await post(`${opt.adminUrl}/config/apps/tls/automation/policies`, {
                subjects: [domain],
                issuers: [{ module: 'internal' }],
            })
            log(`Added TLS automation policy (internal) for ${domain}`)
        } else {
            log(`TLS automation policy already present for ${domain}`)
        }
    }

    // ---------- Caddy routes ----------
    type CaddyRoute = {
        '@id'?: string
        match?: Array<{ host?: string[] } & Record<string, unknown>>
        handle?: Array<
            | {
                  handler: 'reverse_proxy'
                  upstreams?: Array<{ dial?: string } & Record<string, unknown>>
              }
            | Record<string, unknown>
        >
        terminal?: boolean
        [k: string]: unknown
    }

    async function getRoutes(): Promise<CaddyRoute[] | undefined> {
        return get<CaddyRoute[]>(
            `${opt.adminUrl}/config/apps/http/servers/${encodeURIComponent(opt.serverId)}/routes`,
        )
    }

    function findRouteByHost(routes: CaddyRoute[] | undefined, host: string) {
        if (!routes) return { route: undefined as CaddyRoute | undefined, index: -1 }
        for (let i = 0; i < routes.length; i++) {
            const r = routes[i]
            const matches = Array.isArray(r.match) ? r.match : []
            for (const m of matches) {
                if (Array.isArray((m as any).host) && (m as any).host.includes(host)) {
                    return { route: r, index: i }
                }
            }
        }
        return { route: undefined, index: -1 }
    }

    function extractUpstreamPort(route: CaddyRoute): number | undefined {
        const handlers = Array.isArray(route.handle) ? route.handle : []
        for (const h of handlers) {
            if ((h as any).handler === 'reverse_proxy') {
                const ups = (h as any).upstreams
                if (Array.isArray(ups) && ups.length > 0) {
                    const dial = ups[0]?.dial as string | undefined
                    if (dial) {
                        const m = /:(\d+)$/.exec(dial.trim())
                        if (m) return Number(m[1])
                    }
                }
            }
        }
        return undefined
    }

    async function addRoute(domain: string, port: number) {
        const route: CaddyRoute = {
            match: [{ host: [domain] }],
            handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: `localhost:${port}` }] }],
            terminal: true,
        }
        const base = `${opt.adminUrl}/config/apps/http/servers/${encodeURIComponent(opt.serverId)}/routes`
        if (opt.insertFirst) {
            await put(`${base}/0`, route)
        } else {
            await post(base, route)
        }
    }

    async function replaceRouteAt(index: number, domain: string, port: number) {
        const base = `${opt.adminUrl}/config/apps/http/servers/${encodeURIComponent(opt.serverId)}/routes/${index}`
        const updated: CaddyRoute = {
            match: [{ host: [domain] }],
            handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: `localhost:${port}` }] }],
            terminal: true,
        }
        await put(base, updated)
    }

    // ---------- Port liveness ----------
    function isPortActive(port: number, host = '127.0.0.1', timeoutMs = 350): Promise<boolean> {
        return new Promise(resolve => {
            const socket = net.createConnection({ host, port })
            const done = (val: boolean) => {
                socket.removeAllListeners()
                try {
                    socket.end()
                    socket.destroy()
                } catch {}
                resolve(val)
            }
            const timer = setTimeout(() => done(false), timeoutMs)
            socket.once('connect', () => {
                clearTimeout(timer)
                done(true)
            })
            socket.once('error', () => {
                clearTimeout(timer)
                done(false)
            })
        })
    }

    // ---------- /etc/hosts check for .local ----------
    function checkHostsForLocal(domain: string) {
        if (!domain.endsWith('.local')) return
        try {
            const hosts = fs.readFileSync('/etc/hosts', 'utf8')
            const present = hosts
                .split(/\r?\n/)
                .some(line =>
                    line.trim().startsWith('#')
                        ? false
                        : line.split(/\s+/).slice(1).includes(domain),
                )
            if (!present) {
                warn(
                    `Missing /etc/hosts entry for ${domain}. Add it with:\n` +
                        `    sudo bash -c "echo '127.0.0.1 ${domain}' >> /etc/hosts"`,
                )
            }
        } catch {
            warn(
                `Could not read /etc/hosts to verify ${domain}. If requests fail, add:\n` +
                    `    sudo bash -c "echo '127.0.0.1 ${domain}' >> /etc/hosts"`,
            )
        }
    }

    // ---------- Main flow ----------
    async function wireDomain(server: ViteDevServer) {
        const addr = server.httpServer?.address()
        const vitePort =
            addr && typeof addr === 'object' && 'port' in addr ? (addr.port as number) : undefined
        if (!vitePort) throw new Error('Unable to determine Vite dev server port')

        const domain = computeDomain()

        // HTTPS-first bootstrap (server + TLS policy)
        await ensureCaddyServerExists(domain)

        // /etc/hosts check (for .local)
        checkHostsForLocal(domain)

        // Route management (stable domain, port reconciliation)
        const routes = await getRoutes()
        const { route, index } = findRouteByHost(routes, domain)

        if (!route) {
            await addRoute(domain, vitePort)
            printWhereToBrowse(domain)
            return
        }

        const existingPort = extractUpstreamPort(route)
        if (!existingPort) {
            await replaceRouteAt(index, domain, vitePort)
            printWhereToBrowse(domain)
            return
        }

        const active = await isPortActive(existingPort)
        if (active) {
            if (existingPort === vitePort) {
                printWhereToBrowse(domain)
                return
            }
            const msg =
                `Domain '${domain}' is already mapped to active port ${existingPort}. ` +
                `Refusing to overwrite. Stop that service or choose a different domain.`
            if (opt.failOnActiveDomain) {
                // Fail the wiring for this domain but do not disrupt the Vite dev server.
                // This keeps the dev process healthy while clearly reporting the issue.
                err(msg)
                return
            } else {
                warn(msg)
                return
            }
        }

        if (existingPort !== vitePort) {
            await replaceRouteAt(index, domain, vitePort)
        }
        printWhereToBrowse(domain)
    }

    function printWhereToBrowse(domain: string) {
        const httpsPort = pickHttpsPort(opt.listen)
        const url =
            httpsPort && httpsPort !== 443 ? `https://${domain}:${httpsPort}` : `https://${domain}`
        console.log(`  ➜  ${pc.bold('Domain')}: ${pc.cyan(url)} ${pc.dim('(via caddy)')}`)
    }

    function pickHttpsPort(listen: string[]): number | undefined {
        const ports = listen
            .map(a => {
                const m = /:(\d+)$/.exec(a)
                return m ? Number(m[1]) : undefined
            })
            .filter((n): n is number => typeof n === 'number')
        if (ports.includes(443)) return 443
        // prefer any port that's not 80
        return ports.find(p => p !== 80)
    }

    function arraysEqual(a: string[], b: string[]) {
        if (a.length !== b.length) return false
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
        return true
    }

    return {
        name: 'vite-plugin-domain',
        apply: 'serve',
        // Ensure Vite dev server accepts our domain's Host header
        // without requiring users to edit their config manually.
        config(config) {
            try {
                const domain = computeDomain()
                const current = config.server?.allowedHosts
                // If user already allows all hosts, don't change anything
                if (current === true) return

                // Build the next allowed hosts list, preserving existing entries
                const list = Array.isArray(current) ? [...current] : []

                // Helper to see if an entry (with optional leading '.') covers the domain
                const covers = (entry: string, host: string) =>
                    entry.startsWith('.') ? host === entry.slice(1) || host.endsWith(entry) : entry === host

                if (!list.some(e => covers(e, domain))) {
                    list.push(domain)
                    if (opt.verbose) log(`Added ${domain} to Vite server.allowedHosts`)
                }

                return {
                    server: {
                        ...(config.server ?? {}),
                        allowedHosts: list,
                    },
                }
            } catch (e) {
                // Non-fatal: if anything goes wrong, don't block Vite startup
                warn('failed to set server.allowedHosts automatically:', (e as any)?.message || e)
                return
            }
        },
        configureServer(server) {
            server.httpServer?.once('listening', () => {
                wireDomain(server).catch(e => {
                    err('setup failed:', e.message || e)
                })
            })
        },
    }
}
