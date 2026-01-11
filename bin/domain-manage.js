#!/usr/bin/env node

import * as p from '@clack/prompts'
import color from 'picocolors'
import { execSync } from 'node:child_process'

function usage(message) {
    if (message) console.error(message)
    console.error(
        'Usage: vite-plugin-domain [delete|unmap|rm] <domain> [--admin-url <url>] [--server-id <id>] [--kill|--unmap]',
    )
    process.exit(1)
}

const rawArgv = process.argv.slice(2)
const maybeCmd = rawArgv[0]
const argv = ['delete', 'unmap', 'rm'].includes(maybeCmd) ? rawArgv.slice(1) : rawArgv

let domain
let adminUrl = 'http://127.0.0.1:2019'
let serverId = 'vite-dev'
let mode = null

for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--kill') {
        if (mode && mode !== 'kill') usage('Only one of --kill or --unmap can be set.')
        mode = 'kill'
        continue
    }
    if (arg === '--unmap') {
        if (mode && mode !== 'unmap') usage('Only one of --kill or --unmap can be set.')
        mode = 'unmap'
        continue
    }
    if (arg === '--admin-url') {
        const value = argv[++i]
        if (!value) usage('Missing value for --admin-url')
        adminUrl = value
        continue
    }
    if (arg === '--server-id') {
        const value = argv[++i]
        if (!value) usage('Missing value for --server-id')
        serverId = value
        continue
    }
    if (!domain && !arg.startsWith('-')) {
        domain = arg
        continue
    }
    usage(`Unknown argument: ${arg}`)
}

async function httpGetOptional(url) {
    const res = await fetch(url)
    if (res.status === 404) return null
    if (!res.ok) {
        const msg = await res.text()
        throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}${msg ? `\n${msg}` : ''}`)
    }
    const text = await res.text()
    return text ? JSON.parse(text) : null
}

async function httpDelete(url) {
    const res = await fetch(url, { method: 'DELETE' })
    if (!res.ok) {
        const msg = await res.text()
        throw new Error(`DELETE ${url} failed: ${res.status} ${res.statusText}${msg ? `\n${msg}` : ''}`)
    }
}

function extractUpstreamPort(route) {
    const handlers = Array.isArray(route?.handle) ? route.handle : []
    for (const h of handlers) {
        if (h?.handler === 'reverse_proxy') {
            const ups = h?.upstreams
            if (Array.isArray(ups) && ups.length > 0) {
                const dial = ups[0]?.dial
                if (typeof dial === 'string') {
                    const match = /:(\d+)$/.exec(dial.trim())
                    if (match) return Number(match[1])
                }
            }
        }
    }
    return undefined
}

function listPids(port) {
    try {
        const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, { encoding: 'utf8' })
        return out
            .split(/\r?\n/)
            .map(v => v.trim())
            .filter(Boolean)
            .map(v => Number(v))
            .filter(Number.isFinite)
    } catch (err) {
        if (err?.status === 1) return []
        throw err
    }
}

function killPids(pids) {
    for (const pid of pids) {
        try {
            process.kill(pid, 'SIGTERM')
        } catch (err) {
            throw new Error(`Failed to kill pid ${pid}: ${err?.message ?? err}`)
        }
    }
}

async function main() {
    p.intro(color.bgCyan(color.black(' domain-manager ')))

    const routesUrl = `${adminUrl}/config/apps/http/servers/${encodeURIComponent(serverId)}/routes`
    const routes = (await httpGetOptional(routesUrl)) ?? []

    const entries = []
    for (let i = 0; i < routes.length; i++) {
        const route = routes[i]
        const port = extractUpstreamPort(route)
        for (const match of route?.match ?? []) {
            const hosts = match?.host ?? match?.hosts
            if (Array.isArray(hosts)) {
                for (const host of hosts) {
                    if (typeof host === 'string' && host.length > 0) {
                        entries.push({
                            domain: host,
                            routeIndex: i,
                            port,
                        })
                    }
                }
            }
        }
    }

    if (!entries.length) {
        p.outro(color.yellow('No mapped domains found.'))
        return
    }

    if (!domain) {
        const domainMap = new Map()
        for (const entry of entries) {
            const existing = domainMap.get(entry.domain) ?? {
                domain: entry.domain,
                ports: new Set(),
                indices: [],
            }
            if (entry.port) existing.ports.add(entry.port)
            existing.indices.push(entry.routeIndex)
            domainMap.set(entry.domain, existing)
        }

        const options = Array.from(domainMap.values()).map(item => {
            const portLabel =
                item.ports.size === 0
                    ? color.yellow('unknown')
                    : item.ports.size === 1
                        ? color.cyan(`:${Array.from(item.ports)[0]}`)
                        : color.cyan(`:${Array.from(item.ports).join(', ')}`)
            return {
                value: item.domain,
                label: `${item.domain} ${color.dim('→')} ${portLabel}`,
            }
        })

        const pick = await p.autocomplete({
            message: 'Select a domain to manage',
            options,
            placeholder: 'Type to filter domains…',
            maxItems: 8,
        })
        if (p.isCancel(pick)) return
        domain = pick
    }

    const selected = entries.filter(entry => entry.domain === domain)
    if (!selected.length) {
        p.outro(color.red(`No route found for domain ${JSON.stringify(domain)}.`))
        return
    }

    const ports = Array.from(
        new Set(selected.map(entry => entry.port).filter(port => port != null)),
    )
    const port = ports.length === 1 ? ports[0] : undefined

    let action = mode === 'kill' ? 'kill-unmap' : mode === 'unmap' ? 'unmap' : null
    if (!action) {
        action = await p.select({
            message: 'What do you want to do?',
            options: [
                {
                    value: 'kill-unmap',
                    label: `Kill process on port ${port ?? (ports.length ? ports.join(', ') : 'unknown')} and unmap`,
                },
                { value: 'unmap', label: 'Unmap only' },
                { value: 'cancel', label: 'Cancel' },
            ],
        })
        if (p.isCancel(action) || action === 'cancel') return
    }

    const spinner = p.spinner()
    try {
        if (action === 'kill-unmap') {
            let killPort = port
            if (!killPort && ports.length > 1) {
                const pickPort = await p.select({
                    message: 'Multiple ports found. Which one should be killed?',
                    options: ports.map(pv => ({ value: pv, label: String(pv) })),
                })
                if (p.isCancel(pickPort)) return
                killPort = pickPort
            }
            if (!killPort) {
                throw new Error('Port not found for selected domain.')
            }
            spinner.start(`Killing process on port ${killPort}...`)
            const pids = listPids(killPort)
            if (pids.length === 0) {
                spinner.stop(color.yellow(`No process found listening on port ${killPort}.`))
            } else {
                killPids(pids)
                spinner.stop(color.green(`Killed ${pids.length} process(es) on port ${killPort}.`))
            }
        }

        spinner.start(`Unmapping ${domain}...`)
        const indices = selected
            .map(entry => entry.routeIndex)
            .filter(Number.isFinite)
            .sort((a, b) => b - a)

        for (const idx of indices) {
            const delUrl = `${routesUrl}/${idx}`
            await httpDelete(delUrl)
        }
        spinner.stop(color.green(`Unmapped ${domain}.`))
    } catch (err) {
        spinner.stop(color.red('Failed.'))
        p.outro(color.red(err?.message ?? String(err)))
        process.exit(1)
    }

    p.outro(color.green('Done.'))
}

main().catch(err => {
    p.outro(color.red(err?.message ?? String(err)))
    process.exit(1)
})
