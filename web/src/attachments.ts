import { useCallback, useState } from 'react'
import {
  MAX_IMAGES_PER_MESSAGE,
  MAX_IMAGE_BYTES,
  isImageMediaType,
  type ImageAttachment,
} from '../../shared/protocol.js'
import { uuid } from './uuid.js'

/** An attachment plus the bits only the composer needs — a key and a preview URL. */
export type PendingImage = ImageAttachment & { id: string; url: string }

const readAsBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    // `data:<type>;base64,<payload>` — the wire format wants the payload alone.
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.readAsDataURL(file)
  })

/**
 * The image tray behind a composer: paste, drop, or pick files and hold them
 * until the message is sent. Oversized files and non-images are refused with a
 * message rather than silently dropped — a screenshot that vanishes is worse
 * than one that explains itself.
 */
export function useAttachments() {
  const [images, setImages] = useState<PendingImage[]>([])
  const [error, setError] = useState<string | null>(null)

  const add = useCallback(async (files: Iterable<File>) => {
    const picked = [...files].filter((f) => f.type.startsWith('image/'))
    if (picked.length === 0) return
    const accepted: PendingImage[] = []
    let rejected: string | null = null
    for (const file of picked) {
      if (!isImageMediaType(file.type)) {
        rejected = `${file.type.replace('image/', '').toUpperCase()} images aren't supported`
        continue
      }
      if (file.size > MAX_IMAGE_BYTES) {
        rejected = `${file.name || 'That image'} is over ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB`
        continue
      }
      accepted.push({
        id: uuid(),
        name: file.name || undefined,
        mediaType: file.type,
        data: await readAsBase64(file),
        url: URL.createObjectURL(file),
      })
    }
    setImages((prev) => {
      const room = MAX_IMAGES_PER_MESSAGE - prev.length
      if (accepted.length > room) rejected = `Up to ${MAX_IMAGES_PER_MESSAGE} images per message`
      return [...prev, ...accepted.slice(0, Math.max(room, 0))]
    })
    setError(rejected)
  }, [])

  const remove = useCallback((id: string) => {
    setImages((prev) => {
      const gone = prev.find((i) => i.id === id)
      if (gone) URL.revokeObjectURL(gone.url)
      return prev.filter((i) => i.id !== id)
    })
  }, [])

  const clear = useCallback(() => {
    setImages((prev) => {
      for (const i of prev) URL.revokeObjectURL(i.url)
      return []
    })
    setError(null)
  }, [])

  /** The wire shape: previews and ids stay on the client. */
  const payload = useCallback(
    (): ImageAttachment[] | undefined =>
      images.length > 0
        ? images.map(({ name, mediaType, data }) => ({ name, mediaType, data }))
        : undefined,
    [images],
  )

  /** Wire onto a textarea: pasted screenshots become attachments. */
  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const files = [...e.clipboardData.items]
        .filter((i) => i.kind === 'file')
        .map((i) => i.getAsFile())
        .filter((f): f is File => !!f && f.type.startsWith('image/'))
      if (files.length === 0) return
      e.preventDefault()
      void add(files)
    },
    [add],
  )

  return { images, error, add, remove, clear, payload, onPaste, dismissError: () => setError(null) }
}
