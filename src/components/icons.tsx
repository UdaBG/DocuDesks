interface IconProps {
  size?: number
  className?: string
}

function svg(size: number | undefined, className: string | undefined, children: React.ReactNode) {
  return (
    <svg
      width={size ?? 16}
      height={size ?? 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

/** Fountain-pen nib — the app mark. */
export function NibIcon({ size, className }: IconProps) {
  return svg(size, className, (
    <>
      <path d="M12 2c3.5 2.6 5.5 5.8 5.5 9.4 0 2.8-1.6 6-5.5 10.6-3.9-4.6-5.5-7.8-5.5-10.6C6.5 7.8 8.5 4.6 12 2Z" fill="currentColor" stroke="none" />
      <circle cx="12" cy="11" r="1.5" fill="var(--stage, #12161f)" stroke="none" />
      <path d="M12 12.5V19" stroke="var(--stage, #12161f)" strokeWidth="1.4" />
    </>
  ))
}

export function PlusIcon({ size, className }: IconProps) {
  return svg(size, className, <path d="M12 5v14M5 12h14" />)
}

export function InfoIcon({ size, className }: IconProps) {
  return svg(size, className, (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ))
}

/** Text-recognition (OCR): viewfinder corners around a text line. */
export function ScanTextIcon({ size, className }: IconProps) {
  return svg(size, className, (
    <>
      <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
      <path d="M8 12h8M8 15.5h5" />
    </>
  ))
}

export function TrashIcon({ size, className }: IconProps) {
  return svg(size, className, (
    <>
      <path d="M4 7h16M10 11v6M14 11v6" />
      <path d="M6 7l1 13h10l1-13M9 7V4h6v3" />
    </>
  ))
}

export function CheckIcon({ size, className }: IconProps) {
  return svg(size, className, <path d="M4.5 12.5l5 5L19.5 7" />)
}

export function WarnIcon({ size, className }: IconProps) {
  return svg(size, className, (
    <>
      <path d="M12 3.5L22 20H2L12 3.5Z" />
      <path d="M12 10v4.5M12 17.5v.01" />
    </>
  ))
}

export function CloseIcon({ size, className }: IconProps) {
  return svg(size, className, <path d="M6 6l12 12M18 6L6 18" />)
}

export function ChevronLeftIcon({ size, className }: IconProps) {
  return svg(size, className, <path d="M14.5 5.5L8 12l6.5 6.5" />)
}

export function ChevronRightIcon({ size, className }: IconProps) {
  return svg(size, className, <path d="M9.5 5.5L16 12l-6.5 6.5" />)
}

/** Smart-detect spark. */
export function SparkIcon({ size, className }: IconProps) {
  return svg(size, className, (
    <path
      d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4L12 3ZM18.5 15.5l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9.9-2.6Z"
      fill="currentColor"
      stroke="none"
    />
  ))
}

export function DocIcon({ size, className }: IconProps) {
  return svg(size, className, (
    <>
      <path d="M6 3h8l4 4v14H6V3Z" />
      <path d="M14 3v4h4" />
    </>
  ))
}

export function FolderIcon({ size, className }: IconProps) {
  return svg(size, className, <path d="M3 6h6l2 2.5h10V20H3V6Z" />)
}

export function CursorIcon({ size, className }: IconProps) {
  return svg(size, className, <path d="M6 3l12 9.5-5.6 1L15 19.5l-2.6 1.2-2.6-6-4 3.6L6 3Z" />)
}

export function TextIcon({ size, className }: IconProps) {
  return svg(size, className, <path d="M5 6V4h14v2M12 4v16M9 20h6" />)
}

export function RetypeIcon({ size, className }: IconProps) {
  return svg(size, className, (
    <>
      <path d="M4 7V5h9v2M8.5 5v9M7 14h3" />
      <path d="M13.5 20.5l6.8-6.8a1.6 1.6 0 0 0-2.3-2.3l-6.8 6.8-.9 3.2 3.2-.9Z" />
    </>
  ))
}

export function PenIcon({ size, className }: IconProps) {
  return svg(size, className, (
    <path d="M3 20.5c4-.8 3.2-4.2 6-7s5.4-3 7.6-5.2a2.3 2.3 0 0 0-3.3-3.3C11.2 7.2 11 10 8.2 12.8s-6.2 2-7 6" transform="translate(1.5 0)" />
  ))
}

export function SquareIcon({ size, className }: IconProps) {
  return svg(size, className, <rect x="4.5" y="5.5" width="15" height="13" rx="1" />)
}

export function CircleIcon({ size, className }: IconProps) {
  return svg(size, className, <ellipse cx="12" cy="12" rx="7.5" ry="6.5" />)
}

export function LineIcon({ size, className }: IconProps) {
  return svg(size, className, <path d="M4.5 19.5l15-15" />)
}

export function ArrowIcon({ size, className }: IconProps) {
  return svg(size, className, <path d="M4.5 19.5l15-15M19.5 11V4.5H13" />)
}

export function EraserIcon({ size, className }: IconProps) {
  return svg(size, className, (
    <>
      <path d="M9.5 19.5L3.8 13.8a1.8 1.8 0 0 1 0-2.6l7.4-7.4a1.8 1.8 0 0 1 2.6 0l6.4 6.4a1.8 1.8 0 0 1 0 2.6l-6.7 6.7H9.5Z" />
      <path d="M7.5 9.5l7 7M4 19.5h17" />
    </>
  ))
}

/** Whiteout / cover patch: lines of text with a patch over them. */
export function WhiteoutIcon({ size, className }: IconProps) {
  return svg(size, className, (
    <>
      <path d="M4 6h16M4 11h5M4 16h5" />
      <rect x="11.5" y="9" width="9" height="9" rx="1.2" fill="currentColor" stroke="none" opacity="0.25" />
      <rect x="11.5" y="9" width="9" height="9" rx="1.2" />
    </>
  ))
}

export function CopyIcon({ size, className }: IconProps) {
  return svg(size, className, (
    <>
      <rect x="8.5" y="8.5" width="12" height="12" rx="1.5" />
      <path d="M15.5 8.5v-4a1 1 0 0 0-1-1h-10a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h4" />
    </>
  ))
}

export function MergeIcon({ size, className }: IconProps) {
  return svg(size, className, (
    <>
      <path d="M7 3.5v6c0 3 2 4.5 5 4.5s5 1.5 5 4.5v2" />
      <path d="M17 3.5v6c0 1.6-.6 2.8-1.7 3.6" />
      <path d="M14 18l3 3 3-3M4.5 6L7 3.5 9.5 6M14.5 6L17 3.5 19.5 6" />
    </>
  ))
}

export function WatermarkIcon({ size, className }: IconProps) {
  return svg(size, className, (
    <>
      <path d="M12 3.5c3.6 4.2 5.5 7.4 5.5 10a5.5 5.5 0 1 1-11 0c0-2.6 1.9-5.8 5.5-10Z" />
      <path d="M9.5 14a2.5 2.5 0 0 0 2.5 2.5" />
    </>
  ))
}

export function RedoIcon({ size, className }: IconProps) {
  return svg(size, className, (
    <>
      <path d="M16 5l4.5 4.5L16 14" />
      <path d="M20.5 9.5H9a5.5 5.5 0 1 0 0 11h3" />
    </>
  ))
}

export function PagePlusIcon({ size, className }: IconProps) {
  return svg(size, className, (
    <>
      <path d="M6 3h8l4 4v14H6V3Z" />
      <path d="M14 3v4h4M12 10.5v6M9 13.5h6" />
    </>
  ))
}

/** A signature squiggle — the signatures tab. */
export function SquiggleIcon({ size, className }: IconProps) {
  return svg(size, className, (
    <>
      <path d="M3 15c2.5-6 4.5-9 6-7.5S7.5 14 9.5 14.5 14 9 16 9s1 5 3 5.5 2-1.5 2-1.5" />
      <path d="M4 19.5h16" strokeDasharray="2.5 3" />
    </>
  ))
}

/** Remove from this document only: a page with a minus. */
export function DocMinusIcon({ size, className }: IconProps) {
  return svg(size, className, (
    <>
      <path d="M6 3h8l4 4v14H6V3Z" />
      <path d="M14 3v4h4M9 14h6" />
    </>
  ))
}

export function PrinterIcon({ size, className }: IconProps) {
  return svg(size, className, (
    <>
      <path d="M7 8V3.5h10V8M7 16.5H4.5V8h15v8.5H17" />
      <rect x="7" y="13.5" width="10" height="7" rx="0.8" />
      <path d="M16.5 10.75h.01" strokeWidth="2.4" />
    </>
  ))
}

export function UndoIcon({ size, className }: IconProps) {
  return svg(size, className, (
    <>
      <path d="M8 5L3.5 9.5 8 14" />
      <path d="M3.5 9.5H15a5.5 5.5 0 1 1 0 11h-3" />
    </>
  ))
}
