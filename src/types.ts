import type { SignerApi } from '../electron/preload'

declare global {
  interface Window {
    signer: SignerApi
  }
}

export type PageAnchor = 'first' | 'last' | 'custom'

/**
 * Where a signature sits on a page, in page-relative fractions so the same
 * placement transfers across documents with different page sizes.
 * `yb` is the *bottom* edge of the signature (the line you sign on), measured
 * from the top of the page — the signature grows upward from it.
 */
export interface Placement {
  anchor: PageAnchor
  pageIndex: number
  x: number
  yb: number
  w: number
  /**
   * Vertical space available at this spot (fraction of page height). When the
   * signature's aspect ratio would exceed it, the stamp shrinks to fit.
   */
  maxH?: number
}

/** An additional per-document signature stamp (beyond the bulk placement). */
export interface ExtraStamp {
  id: string
  signatureId: string
  placement: Placement
}

/**
 * The rectangle a signature actually occupies for a placement, honouring the
 * spot's max-height constraint. Same math for preview pixels and PDF points.
 */
export function fitStampBox(
  pl: Placement,
  sigW: number,
  sigH: number,
  pageW: number,
  pageH: number,
): { x: number; yTop: number; w: number; h: number } {
  let w = pl.w * pageW
  let h = w * (sigH / sigW)
  if (pl.maxH) {
    const maxH = pl.maxH * pageH
    if (h > maxH) {
      h = maxH
      w = h * (sigW / sigH)
    }
  }
  const x = Math.max(0, Math.min(pl.x * pageW, pageW - w))
  const yTop = Math.max(0, Math.min(pl.yb * pageH - h, pageH - h))
  return { x, yTop, w, h }
}

export type DocStatus = 'ready' | 'no-target' | 'signed' | 'error'

export interface SigDoc {
  id: string
  name: string
  path?: string
  bytes: Uint8Array
  pageCount: number
  /** bumped whenever bytes are replaced in place (e.g. edits applied) */
  rev: number
  status: DocStatus
  /** Smart-detected placement. `null` = detection ran and found nothing. `undefined` = not run. */
  smart?: Placement | null
  /** Per-document manual correction, takes precedence over `smart`. */
  override?: Placement | null
  /** stack-wide extra stamps that were removed for this document only */
  excludedStamps?: string[]
  /** the bulk/primary stamp was removed for this document */
  primaryDisabled?: boolean
  signedPath?: string
  error?: string
}

export interface SavedSignature {
  id: string
  name: string
  dataUrl: string
  width: number
  height: number
  createdAt: number
}

export type SignMode = 'manual' | 'smart'

export type InkMode = 'original' | 'black' | 'blue-black' | 'royal'

export const INK_COLORS: Record<Exclude<InkMode, 'original'>, string> = {
  black: '#1c1c1e',
  'blue-black': '#26357c',
  royal: '#2f45c4',
}

/** Resolve which page of a document a placement lands on. */
export function resolvePageIndex(placement: Placement, pageCount: number): number {
  if (placement.anchor === 'first') return 0
  if (placement.anchor === 'last') return pageCount - 1
  return Math.min(placement.pageIndex, pageCount - 1)
}

/** The placement that will actually be used for a document, or null if none. */
export function effectivePlacement(
  doc: SigDoc,
  mode: SignMode,
  manual: Placement,
): Placement | null {
  if (mode === 'manual') return manual
  return doc.override ?? doc.smart ?? null
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}
