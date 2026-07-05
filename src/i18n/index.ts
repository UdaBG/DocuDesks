import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './en.json'
import si from './si.json'
import de from './de.json'
import fr from './fr.json'
import es from './es.json'
import sv from './sv.json'

export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'si', label: 'සිංහල' },
  { code: 'de', label: 'Deutsch' },
  { code: 'fr', label: 'Français' },
  { code: 'es', label: 'Español' },
  { code: 'sv', label: 'Svenska' },
] as const

export type LanguageCode = (typeof LANGUAGES)[number]['code']

export function matchLanguage(locale: string): LanguageCode {
  const base = locale.toLowerCase().split(/[-_]/)[0]
  const hit = LANGUAGES.find((l) => l.code === base)
  return hit ? hit.code : 'en'
}

i18next.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    si: { translation: si },
    de: { translation: de },
    fr: { translation: fr },
    es: { translation: es },
    sv: { translation: sv },
  },
  lng: 'en',
  fallbackLng: 'en',
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
})

export default i18next
