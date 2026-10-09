export function copyProd(opts: {
  from: string
  to: string
  force?: boolean
  log?: (line: string) => void
}): Promise<string[]>
