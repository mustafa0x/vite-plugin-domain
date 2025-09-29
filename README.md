# vite-plugin-domain

**Juggling multiple Vite apps and can't remember which port is which?** 

Stop playing the localhost lottery. This plugin automatically assigns memorable domains to each of your projects — derived from the folder name or package.json — so `localhost:5173`, `localhost:5174`, and `localhost:5175` become `frontend.local`, `admin.local`, and `api.local`.

![Vite dev server with stable domain from vite-plugin-domain](https://raw.githubusercontent.com/mustafa0x/vite-plugin-domain/main/vite-start.png)

## The problem

You're working on multiple Vite projects. Each one claims a random port. You have browser tabs open to:
- `localhost:5173` — wait, is this the admin panel or the customer app?
- `localhost:5174` — definitely the API... or was it the docs site?
- `localhost:3000` — something's running here but you forgot what

Tomorrow when you restart everything, the ports shuffle around. The API that was on 5173 is now on 5175. Your bookmarks are useless. Your muscle memory is worthless.

## The solution

This tiny plugin wires each project to a stable local domain via [Caddy](https://caddyserver.com). Now you have:
- `frontend.local` — always your frontend, no matter the port
- `admin.local` — always your admin panel
- `api.local` — always your API

Start any project in any order. Restart them whenever. The domains stay the same.

## What it does
The plugin automatically:
- Configures a Caddy HTTP server with HTTPS via the internal issuer
- Routes your domain to whatever port Vite picks
- Generates domain names from your folder or package.json
- Shares one Caddy instance across all your projects

## Installation
```bash
pnpm add -D vite-plugin-domain
```

## Prerequisites

### Install and start Caddy
1. [Install Caddy](https://caddyserver.com/docs/install) for your platform
2. Trust Caddy's local CA (one-time setup):
   ```bash
   sudo caddy trust
   ```
3. Start Caddy with the admin API enabled:
   ```bash
   caddy run
   ```
   The admin API runs on `http://127.0.0.1:2019` by default. The plugin uses this API to configure domains dynamically.

## Configuration

Add the plugin to your `vite.config.ts`:

```ts
import { defineConfig } from 'vite'
import domain from 'vite-plugin-domain'

export default defineConfig({
  plugins: [
    domain({
      // All options are optional with sensible defaults:
      adminUrl: 'http://127.0.0.1:2019',   // Caddy admin API endpoint
      serverId: 'vite-dev',                // Caddy server identifier
      listen: [':443', ':80'],             // Ports Caddy should listen on
      nameSource: 'folder',                // Use folder name for domain ('folder' | 'pkg')
      tld: 'local',                        // Top-level domain suffix
      // domain: 'myapp.local',            // Explicit domain (overrides nameSource+tld)
      failOnActiveDomain: true,            // Fail if domain already has an active route
      insertFirst: true,                   // Insert new route at top of route list
      verbose: false,                      // Enable detailed logging
    })
  ],
  server: {
    // Required for .local domains:
    allowedHosts: ['.local'],
  }
})
```

## How it works

When you start your Vite dev server:
1. The plugin connects to Caddy's admin API
2. Creates or updates a Caddy server configuration
3. Adds a route from your domain to Vite's dev server port
4. Prints the URL where you can access your app

## Domain configuration

### Automatic naming
By default, the plugin generates a domain based on:
- **Folder name** (`nameSource: 'folder'`) — Uses the current directory name
- **Package name** (`nameSource: 'pkg'`) — Uses the `name` field from `package.json`

The generated domain follows the pattern: `{name}.{tld}`

### Manual naming
Override automatic naming by specifying an explicit domain:
```ts
domain({ domain: 'my-custom-app.local' })
```

## Choosing a TLD: .local vs .localhost

### Using .local (recommended)
Shorter and cleaner, but requires one-time setup:

1. Add to Vite's allowed hosts:
   ```ts
   server: { allowedHosts: ['.local'] }
   ```

2. Add an entry to `/etc/hosts`:
   ```bash
   sudo bash -c "echo '127.0.0.1 myapp.local' >> /etc/hosts"
   ```
   Note: Some networks use `.local` for mDNS. The explicit hosts entry ensures local resolution.

### Using .localhost
Works without additional setup in most browsers:

```ts
domain({ tld: 'localhost' })
```

Browsers typically resolve `*.localhost` to `127.0.0.1` automatically. If Vite blocks it, add to allowed hosts:
```ts
server: { allowedHosts: ['.localhost'] }
```

## Advanced usage

### Multiple projects
Run several Vite projects simultaneously with different domains:

```ts
// Project A: vite.config.ts
domain({ domain: 'frontend.local' })

// Project B: vite.config.ts
domain({ domain: 'admin.local' })

// Project C: vite.config.ts
domain({ domain: 'api.local' })
```

All three projects can run concurrently, each accessible via its own domain, all routing through the same Caddy instance.

### Custom Caddy server configuration
If you need different Caddy server settings per project:

```ts
domain({
  serverId: 'my-project-server',
  listen: [':8443', ':8080'],  // Custom ports
  adminUrl: 'http://127.0.0.1:2019'
})
```

### Debugging
Enable verbose logging to troubleshoot issues:

```ts
domain({ verbose: true })
```

## Troubleshooting

### Browser shows "connection refused"
- Ensure Caddy is running: `caddy run`
- Check the domain resolves: `ping myapp.local`
- Verify `/etc/hosts` entry exists for `.local` domains

### Certificate warnings
- Run `sudo caddy trust` to install Caddy's local CA
- Restart your browser after trusting the certificate

### "Domain already has an active route" error
- Another project is using this domain
- Either stop the other project or use a different domain
- Or set `failOnActiveDomain: false` to override (use with caution)

### Vite shows "Invalid Host header"
- Add your TLD to Vite's allowed hosts: `server: { allowedHosts: ['.local'] }`

## License
MIT
