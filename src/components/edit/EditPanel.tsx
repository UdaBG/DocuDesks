import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useApp } from '../../store'
import { useEdit } from '../../editor/editStore'
import { availableFonts, hasFullFontList, type EditorFont } from '../../editor/fonts'
import { needsComplexShaping, type DashStyle, type PenVariant, type TextObj } from '../../editor/types'
import ColorField from './ColorField'
import WatermarkDialog from './WatermarkDialog'
import { WatermarkIcon } from '../icons'

const HIGHLIGHT_DEFAULT = '#ffe066'
const PENS: PenVariant[] = ['ball', 'marker', 'highlight']
const DASHES: DashStyle[] = ['solid', 'dashed', 'dotted']

export default function EditPanel() {
  const { t } = useTranslation()
  const docs = useApp((s) => s.docs)
  const selectedDocId = useApp((s) => s.selectedDocId)
  const doc = docs.find((d) => d.id === selectedDocId)
  const tool = useEdit((s) => s.tool)
  const style = useEdit((s) => s.style)
  const setStyle = useEdit((s) => s.setStyle)
  const session = useEdit((s) => (doc ? s.sessions[doc.id] : undefined))
  const updateObject = useEdit((s) => s.updateObject)
  const pushHistory = useEdit((s) => s.pushHistory)
  const [fonts, setFonts] = useState<EditorFont[]>([])
  const [wmOpen, setWmOpen] = useState(false)

  useEffect(() => {
    void availableFonts().then(setFonts)
    if (hasFullFontList()) return
    // Some WebViews gate queryLocalFonts behind user activation: retry from
    // inside real pointer gestures until the full list is available.
    const retry = () => {
      void availableFonts().then((list) => {
        setFonts(list)
        if (hasFullFontList()) window.removeEventListener('pointerdown', retry, true)
      })
    }
    window.addEventListener('pointerdown', retry, true)
    return () => window.removeEventListener('pointerdown', retry, true)
  }, [])

  const selected = session?.selectedId
    ? session.objects.find((o) => o.id === session.selectedId) ?? null
    : null

  const lastPushRef = useRef(0)

  /** Update the default style and, when applicable, the selected object too. */
  function apply(patch: Partial<typeof style>, objPatch: Record<string, unknown> | null) {
    setStyle(patch)
    if (doc && selected && objPatch) {
      // rapid drags (color picker, sliders) collapse into one history entry
      const now = Date.now()
      if (now - lastPushRef.current > 600) {
        pushHistory(doc.id)
        lastPushRef.current = now
      }
      updateObject(doc.id, selected.id, objPatch)
    }
  }

  const textObj: TextObj | null = selected?.kind === 'text' ? selected : null
  const showText = tool === 'text' || tool === 'retype' || !!textObj
  const showPen = tool === 'pen' || selected?.kind === 'ink'
  // whiteout covers have exactly one property: their fill. It auto-matches
  // the page background when drawn; this control overrides it.
  const whiteoutObj = selected?.kind === 'whiteout' ? selected : null
  const whiteoutContext = tool === 'whiteout' || !!whiteoutObj
  const showStroke = !showText && !whiteoutContext
  const showFill =
    tool === 'rect' || tool === 'ellipse' || selected?.kind === 'rect' || selected?.kind === 'ellipse'
  const showDash =
    showFill ||
    tool === 'line' ||
    tool === 'arrow' ||
    selected?.kind === 'line' ||
    selected?.kind === 'arrow'
  const dashValue: DashStyle =
    selected && 'dash' in selected ? (selected.dash ?? 'solid') : style.dash

  const strokeValue =
    selected && 'stroke' in selected ? selected.stroke : selected?.kind === 'ink' ? selected.color : style.stroke
  const fillValue = selected && 'fill' in selected && selected.kind !== 'whiteout' ? selected.fill : style.fill
  const widthValue =
    selected && 'strokeWidthPt' in selected
      ? selected.strokeWidthPt
      : selected?.kind === 'ink'
        ? selected.widthPt / 1.6
        : style.strokeWidthPt
  const opacityValue = selected && 'opacity' in selected ? selected.opacity : style.opacity

  const flag = (k: 'bold' | 'italic' | 'underline' | 'strike') => (textObj ? textObj[k] : style[k])
  const highlightOn = textObj ? textObj.highlight !== null : style.highlight !== null

  function toggleFlag(k: 'bold' | 'italic' | 'underline' | 'strike') {
    const v = !flag(k)
    apply({ [k]: v }, textObj ? { [k]: v } : null)
  }

  return (
    <aside className="panel right-panel">
      <section>
        <div className="panel-head">
          <h2>{t('edit.properties')}</h2>
        </div>

        {showText && (
          <>
            <label className="field">
              <span>{t('edit.font')}</span>
              <select
                value={textObj?.fontId ?? style.fontId}
                onChange={(e) =>
                  apply({ fontId: e.target.value }, textObj ? { fontId: e.target.value } : null)
                }
              >
                {fonts.map((f) => (
                  <option key={f.id} value={f.id} style={{ fontFamily: f.css }}>
                    {f.label}
                  </option>
                ))}
              </select>
              {textObj?.retypeOf?.pdfFontName && (
                <span className="muted original-font">
                  {t('edit.originalFont', { name: textObj.retypeOf.pdfFontName })}
                </span>
              )}
            </label>
            {textObj && needsComplexShaping(textObj.text) && (
              <p className="shaping-warn">{t('edit.shapingWarn')}</p>
            )}

            <div className="field">
              <span className="field-label">{t('edit.textStyle')}</span>
              <div className="style-toggles">
                <button
                  className={flag('bold') ? 'style-toggle active' : 'style-toggle'}
                  style={{ fontWeight: 800 }}
                  title={t('edit.bold')}
                  onClick={() => toggleFlag('bold')}
                >
                  B
                </button>
                <button
                  className={flag('italic') ? 'style-toggle active' : 'style-toggle'}
                  style={{ fontStyle: 'italic', fontFamily: 'Georgia, serif' }}
                  title={t('edit.italic')}
                  onClick={() => toggleFlag('italic')}
                >
                  I
                </button>
                <button
                  className={flag('underline') ? 'style-toggle active' : 'style-toggle'}
                  style={{ textDecoration: 'underline' }}
                  title={t('edit.underline')}
                  onClick={() => toggleFlag('underline')}
                >
                  U
                </button>
                <button
                  className={flag('strike') ? 'style-toggle active' : 'style-toggle'}
                  style={{ textDecoration: 'line-through' }}
                  title={t('edit.strike')}
                  onClick={() => toggleFlag('strike')}
                >
                  S
                </button>
                <button
                  className={highlightOn ? 'style-toggle active hl' : 'style-toggle hl'}
                  title={t('edit.highlight')}
                  onClick={() => {
                    const v = highlightOn ? null : HIGHLIGHT_DEFAULT
                    apply({ highlight: v }, textObj ? { highlight: v } : null)
                  }}
                >
                  <span className="hl-chip">H</span>
                </button>
              </div>
            </div>

            <label className="field">
              <span>
                {t('edit.fontSize')} — {textObj?.sizePt ?? style.fontSizePt} pt
              </span>
              <input
                type="range"
                min={5}
                max={96}
                step={1}
                value={textObj?.sizePt ?? style.fontSizePt}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  apply({ fontSizePt: v }, textObj ? { sizePt: v } : null)
                }}
              />
            </label>
            <ColorField
              label={t('edit.textColor')}
              value={textObj?.color ?? style.textColor}
              onChange={(v) => apply({ textColor: v ?? '#1c1c1e' }, textObj ? { color: v } : null)}
            />
          </>
        )}

        {showPen && (
          <div className="field">
            <span className="field-label">{t('edit.penType')}</span>
            <div className="pen-variants">
              {PENS.map((p) => (
                <button
                  key={p}
                  className={style.pen === p ? 'seg active' : 'seg'}
                  onClick={() => {
                    setStyle({ pen: p })
                    if (p === 'highlight') setStyle({ stroke: HIGHLIGHT_DEFAULT })
                  }}
                >
                  {t(`edit.pen.${p}`)}
                </button>
              ))}
            </div>
          </div>
        )}

        {whiteoutContext && (
          <ColorField
            label={t('edit.fill')}
            value={whiteoutObj?.fill ?? style.whiteoutFill}
            onChange={(v) => {
              const c = v ?? '#ffffff'
              apply({ whiteoutFill: c }, whiteoutObj ? { fill: c } : null)
            }}
          />
        )}

        {showStroke && (
          <>
            <ColorField
              label={t('edit.stroke')}
              value={strokeValue}
              onChange={(v) => {
                const c = v ?? '#1c1c1e'
                apply(
                  { stroke: c },
                  selected
                    ? selected.kind === 'ink'
                      ? { color: c }
                      : 'stroke' in selected
                        ? { stroke: c }
                        : null
                    : null,
                )
              }}
            />
            {showFill && (
              <ColorField
                label={t('edit.fill')}
                value={fillValue}
                allowNone
                onChange={(v) =>
                  apply({ fill: v }, selected && 'fill' in selected ? { fill: v } : null)
                }
              />
            )}
            {showDash && (
              <div className="field">
                <span className="field-label">{t('edit.dash')}</span>
                <div className="dash-toggles">
                  {DASHES.map((d) => (
                    <button
                      key={d}
                      className={dashValue === d ? 'dash-toggle active' : 'dash-toggle'}
                      title={t(`edit.dash.${d}`)}
                      aria-label={t(`edit.dash.${d}`)}
                      onClick={() =>
                        apply({ dash: d }, selected && 'dash' in selected ? { dash: d } : null)
                      }
                    >
                      <span className={`dash-sample dash-${d}`} />
                    </button>
                  ))}
                </div>
              </div>
            )}
            <label className="field">
              <span>
                {t('edit.width')} — {Number(widthValue).toFixed(1)} pt
              </span>
              <input
                type="range"
                min={0.5}
                max={10}
                step={0.5}
                value={widthValue}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  apply(
                    { strokeWidthPt: v },
                    selected
                      ? selected.kind === 'ink'
                        ? { widthPt: v * 1.6 }
                        : 'strokeWidthPt' in selected
                          ? { strokeWidthPt: v }
                          : null
                      : null,
                  )
                }}
              />
            </label>
            <label className="field">
              <span>
                {t('edit.opacity')} — {Math.round(opacityValue * 100)}%
              </span>
              <input
                type="range"
                min={0.1}
                max={1}
                step={0.05}
                value={opacityValue}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  apply({ opacity: v }, selected && 'opacity' in selected ? { opacity: v } : null)
                }}
              />
            </label>
          </>
        )}
      </section>

      <section>
        <div className="panel-head">
          <h2>{t('edit.watermark')}</h2>
        </div>
        <button className="ghost-btn wide" disabled={!doc || !session} onClick={() => setWmOpen(true)}>
          <WatermarkIcon size={15} />
          {session?.watermark
            ? session.watermark.kind === 'image'
              ? t('wm.kind.image')
              : session.watermark.text
            : t('wm.add')}
        </button>
        <p className="muted">{t('wm.note')}</p>
      </section>

      {wmOpen && doc && session && (
        <WatermarkDialog docId={doc.id} current={session.watermark} onClose={() => setWmOpen(false)} />
      )}
    </aside>
  )
}
