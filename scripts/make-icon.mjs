import { Resvg } from '@resvg/resvg-js'
import { mkdir, writeFile } from 'node:fs/promises'

// Fountain-pen nib on a royal-blue tile.
const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#3b53d9"/>
      <stop offset="1" stop-color="#2438a8"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="104" fill="url(#bg)"/>
  <path d="M256 84c74 55 116 122 116 198 0 59-34 127-116 224-82-97-116-165-116-224 0-76 42-143 116-198Z" fill="#ffffff"/>
  <circle cx="256" cy="272" r="30" fill="#2438a8"/>
  <rect x="248" y="300" width="16" height="140" rx="8" fill="#2438a8"/>
</svg>`

const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: 512 } })
const png = resvg.render().asPng()
await mkdir('build', { recursive: true })
await writeFile('build/icon.png', png)
console.log('build/icon.png written', png.length, 'bytes')
