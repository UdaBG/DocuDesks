// Filename helpers — mostly to tame Android content-URI "names". A pick from
// Android's Downloads/MediaStore comes back as a URI whose last path segment
// is the raw document id (e.g. "document%3A1000048777"), not the file's real
// name. The platform forwards the true DISPLAY_NAME through the pick net; these
// are the fallbacks and the save-time sanitiser so we never write a file with
// an illegal or meaningless name.

function isUri(s: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s)
}

/** decodeURIComponent that returns the input unchanged on a malformed escape. */
function tryDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/**
 * Best-effort display name for a file from a filesystem path or a content URI.
 * Real Android names arrive separately (see the pick net); this just yields
 * something clean — "document:1000048777" rather than "document%3A1000048777"
 * — when that is all we have.
 */
export function displayNameFromPath(pathOrUri: string): string {
  const s = (isUri(pathOrUri) ? tryDecode(pathOrUri) : pathOrUri).split(/[\\/]/).pop()?.trim() ?? ''
  return s || 'document.pdf'
}

/**
 * A clean, legal filename stem (no extension) that saves safely on Android and
 * Windows. Strips path parts and characters those filesystems reject — a
 * content-URI id like "document:1000048777" would otherwise create a file the
 * OS shows as a generic, unopenable blob rather than a PDF.
 */
export function safeStem(name: string): string {
  // Only percent-decode real URIs (content://…%3A…). A plain filename may
  // legitimately contain '%' (e.g. "Report 50%.pdf") — decoding/stripping that
  // would rename the user's file, so leave '%' alone for non-URIs.
  let base = isUri(name) ? tryDecode(name) : name
  base = base
    .replace(/^.*[\\/]/, '') // drop any leading path
    .replace(/\.pdf$/i, '') // drop the extension we re-add
    .replace(/[\\/:*?"<>|]/g, '_') // illegal on Windows/Android
    .replace(/\s+/g, ' ') // collapse whitespace
    .replace(/_{2,}/g, '_') // collapse repeats
    .replace(/^[._\s]+|[._\s]+$/g, '') // trim leading/trailing dot, underscore, space
  return base || 'document'
}
