// Filename helpers — mostly to tame Android content-URI "names". A pick from
// Android's Downloads/MediaStore comes back as a URI whose last path segment
// is the raw document id (e.g. "document%3A1000048777"), not the file's real
// name. The platform forwards the true DISPLAY_NAME through the pick net; these
// are the fallbacks and the save-time sanitiser so we never write a file with
// an illegal or meaningless name.

function isUri(s: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s)
}

/**
 * Best-effort display name for a file from a filesystem path or a content URI.
 * Real Android names arrive separately (see the pick net); this just yields
 * something clean — "document:1000048777" rather than "document%3A1000048777"
 * — when that is all we have.
 */
export function displayNameFromPath(pathOrUri: string): string {
  let s = pathOrUri
  if (isUri(s)) {
    try {
      s = decodeURIComponent(s)
    } catch {
      /* malformed escape — keep the raw string */
    }
  }
  s = s.split(/[\\/]/).pop()?.trim() ?? ''
  return s || 'document.pdf'
}

/**
 * A clean, legal filename stem (no extension) that saves safely on Android and
 * Windows. Strips path parts and characters those filesystems reject — a
 * content-URI id like "document:1000048777" would otherwise create a file the
 * OS shows as a generic, unopenable blob rather than a PDF.
 */
export function safeStem(name: string): string {
  let base = name
  if (isUri(base) || base.includes('%')) {
    try {
      base = decodeURIComponent(base)
    } catch {
      /* keep raw; the replace below still sanitises it */
    }
  }
  base = base
    .replace(/^.*[\\/]/, '') // drop any leading path
    .replace(/\.pdf$/i, '') // drop the extension we re-add
    .replace(/[\\/:*?"<>|%]/g, '_') // illegal / risky filename chars
    .replace(/\s+/g, ' ') // collapse whitespace
    .replace(/_{2,}/g, '_') // collapse repeats
    .replace(/^[._\s]+|[._\s]+$/g, '') // trim leading/trailing dot, underscore, space
  return base || 'document'
}
