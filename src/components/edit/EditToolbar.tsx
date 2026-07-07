import { useTranslation } from 'react-i18next'
import { useEdit } from '../../editor/editStore'
import type { ToolId } from '../../editor/types'
import {
  ArrowIcon,
  CircleIcon,
  CursorIcon,
  EraserIcon,
  LineIcon,
  PenIcon,
  RetypeIcon,
  ScanTextIcon,
  SquareIcon,
  TextIcon,
  WhiteoutIcon,
} from '../icons'

const TOOLS: { id: ToolId; icon: React.ComponentType<{ size?: number }>; key: string; sc: string }[] = [
  { id: 'select', icon: CursorIcon, key: 'tool.select', sc: 'V' },
  { id: 'retype', icon: RetypeIcon, key: 'tool.retype', sc: 'X' },
  { id: 'text', icon: TextIcon, key: 'tool.text', sc: 'T' },
  { id: 'pen', icon: PenIcon, key: 'tool.pen', sc: 'P' },
  { id: 'rect', icon: SquareIcon, key: 'tool.rect', sc: 'R' },
  { id: 'ellipse', icon: CircleIcon, key: 'tool.ellipse', sc: 'O' },
  { id: 'line', icon: LineIcon, key: 'tool.line', sc: 'L' },
  { id: 'arrow', icon: ArrowIcon, key: 'tool.arrow', sc: 'A' },
  { id: 'erase', icon: EraserIcon, key: 'tool.erase', sc: 'E' },
  { id: 'whiteout', icon: WhiteoutIcon, key: 'tool.whiteout', sc: 'W' },
]

export default function EditToolbar() {
  const { t } = useTranslation()
  const tool = useEdit((s) => s.tool)
  const setTool = useEdit((s) => s.setTool)
  const ocrOverride = useEdit((s) => s.ocrOverride)
  const setOcrOverride = useEdit((s) => s.setOcrOverride)
  const ocrLabel = t(
    ocrOverride === 'on' ? 'edit.ocr.on' : ocrOverride === 'off' ? 'edit.ocr.off' : 'edit.ocr.auto',
  )
  return (
    <div className="edit-toolbar" role="toolbar" aria-label={t('edit.toolbar')}>
      {TOOLS.map(({ id, icon: Icon, key, sc }) => (
        <button
          key={id}
          className={tool === id ? 'edit-tool active' : 'edit-tool'}
          title={`${t(key)} (${sc})`}
          aria-label={t(key)}
          onClick={() => setTool(id)}
        >
          <Icon size={17} />
        </button>
      ))}
      <span className="edit-toolbar-sep" />
      <button
        className={`edit-tool ocr-toggle${ocrOverride === 'on' ? ' active' : ''}${ocrOverride === 'off' ? ' off' : ''}`}
        title={ocrLabel}
        aria-label={ocrLabel}
        onClick={() => setOcrOverride(ocrOverride === null ? 'on' : ocrOverride === 'on' ? 'off' : null)}
      >
        <ScanTextIcon size={17} />
      </button>
    </div>
  )
}
