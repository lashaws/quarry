/**
 * Builds the `ssl` option handed to node-postgres.
 *
 * Pure and side-effect-free — the CA file read is injected — so the decision
 * logic is unit-testable without a filesystem or a database. See test/ssl.test.ts.
 *
 * Why this is more than a boolean:
 *
 * 1. `ssl: true` used to mean `{ rejectUnauthorized: false }`: encrypted, but any
 *    certificate on the network path was accepted. That is fine for a container on
 *    a private subnet and wrong for anything reached across a laptop's network, so
 *    the mode is now explicit and `verify-full` actually verifies.
 *
 * 2. Passing `ca` to Node *replaces* the default trust store rather than extending
 *    it. Amazon RDS *instances* present certificates signed by regional "Amazon RDS
 *    <region> Root CA" entries, which ship in the RDS global bundle and are absent
 *    from Node's defaults. An RDS *Proxy* presents a certificate chained to the
 *    public Amazon Trust Services roots, which are in Node's defaults and absent
 *    from the RDS bundle. Trust either one alone and the other handshake fails with
 *    "unable to get local issuer certificate" — verification working correctly
 *    against the wrong trust set. So verify-full trusts both at once.
 *
 * 3. Through a port-forward you connect to `localhost`, which no RDS certificate
 *    carries, so hostname verification fails. `servername` (SNI, and what Node
 *    checks the certificate against) points verification at the real endpoint name
 *    while the socket still goes to the tunnel. That is what makes verify-full
 *    usable through a tunnel without editing /etc/hosts.
 */
import * as net from 'node:net'
import * as tls from 'node:tls'
import type { ConnectionConfig, SslMode } from '@shared/ipc'

/** Shape node-postgres accepts for `ClientConfig.ssl`. */
export interface SslOptions {
  ca?: string[]
  rejectUnauthorized: boolean
  servername?: string
}

export interface SslResult {
  ssl: SslOptions | undefined
  /** Surfaced to the user when a choice was downgraded; never thrown. */
  warning?: string
}

/**
 * `sslMode` wins. Falls back to the legacy boolean so connections saved before
 * this existed behave exactly as they did: `true` was always unverified, which is
 * `require`, not `verify-full`.
 */
export function resolveSslMode(cfg: Pick<ConnectionConfig, 'ssl' | 'sslMode'>): SslMode {
  if (cfg.sslMode !== undefined) return cfg.sslMode
  return cfg.ssl === true ? 'require' : 'disable'
}

/**
 * The name the certificate is checked against: the explicit override when set,
 * otherwise the host being dialled. Empty strings are treated as unset so a blank
 * form field cannot silently disable hostname verification.
 */
export function verificationName(cfg: Pick<ConnectionConfig, 'host' | 'sslServerName'>): string | undefined {
  const override = cfg.sslServerName?.trim()
  if (override !== undefined && override !== '') return override
  const host = cfg.host?.trim()
  return host !== undefined && host !== '' ? host : undefined
}

/**
 * True when the socket must be dialled by IP address rather than by name.
 *
 * node-postgres sets `servername` to the host it dials whenever that host is a
 * name rather than an IP literal, overwriting whatever the ssl options carried
 * (pg/lib/connection.js, upgradeToSSL). So `host: localhost` plus a
 * `sslServerName` override silently verifies against "localhost" and fails. The
 * driver resolves the name itself and dials the address: pg then leaves
 * `servername` alone and verification checks the real endpoint name.
 */
export function needsAddressDial(
  cfg: Pick<ConnectionConfig, 'host' | 'ssl' | 'sslMode' | 'sslServerName'>
): boolean {
  if (resolveSslMode(cfg) === 'disable') return false
  const host = cfg.host?.trim() ?? ''
  if (host === '' || net.isIP(host) !== 0) return false
  const name = verificationName(cfg)
  return name !== undefined && name !== host
}

export function buildSslOptions(
  cfg: Pick<ConnectionConfig, 'host' | 'ssl' | 'sslMode' | 'sslServerName'>,
  readCaBundle: () => string,
  defaultRoots: readonly string[] = tls.rootCertificates
): SslResult {
  const mode = resolveSslMode(cfg)
  if (mode === 'disable') return { ssl: undefined }

  const servername = verificationName(cfg)

  if (mode === 'require') {
    return { ssl: { rejectUnauthorized: false, servername } }
  }

  let bundle: string
  try {
    bundle = readCaBundle()
  } catch (e) {
    // Downgrading silently would present an encrypted-and-verified UI over an
    // unverified connection, so say so instead.
    return {
      ssl: { rejectUnauthorized: false, servername },
      warning:
        'verify-full requested but the RDS CA bundle could not be read ' +
        `(${e instanceof Error ? e.message : String(e)}). Connected encrypted but UNVERIFIED.`
    }
  }

  const rdsCerts = splitPem(bundle)
  if (rdsCerts.length === 0) {
    return {
      ssl: { rejectUnauthorized: false, servername },
      warning: 'verify-full requested but the CA bundle held no certificates. Connected encrypted but UNVERIFIED.'
    }
  }

  return {
    ssl: {
      // Both trust sets — see note 2 above.
      ca: [...defaultRoots, ...rdsCerts],
      rejectUnauthorized: true,
      servername
    }
  }
}

/** Split a concatenated PEM into individual certificates. */
export function splitPem(bundle: string): string[] {
  const matches = bundle.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)
  return matches ?? []
}
