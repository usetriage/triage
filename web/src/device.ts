/**
 * Whether this page is open on the machine running the daemon. A paired phone
 * reaches it by a LAN address (server/remote.ts); anything that acts on the
 * Mac's own desktop — the native folder chooser — is offered only here.
 */
// Mirrors isLoopbackHostname in server/remote.ts — `triage.localhost` included.
export const onThisMac = (): boolean => {
  const h = location.hostname
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === '[::1]' ||
    h === '::1' ||
    /^127\.\d+\.\d+\.\d+$/.test(h)
  )
}
