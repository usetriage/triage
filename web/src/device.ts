/**
 * Whether this page is open on the machine running the daemon. A paired phone
 * reaches it by a LAN address (server/remote.ts); anything that acts on the
 * Mac's own desktop — the native folder chooser — is offered only here.
 */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export const onThisMac = (): boolean => LOOPBACK.has(location.hostname)
