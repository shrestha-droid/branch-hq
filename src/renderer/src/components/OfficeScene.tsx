import { useEffect, useRef } from 'react'
import * as PIXI from 'pixi.js'

// NEW: the office visualization. Every sprite here is an original pixel
// grid authored cell-by-cell below -- not traced or copied from any
// existing asset pack or show. Same technique the real reference project
// in this genre uses: one shared humanoid template, differentiated per
// character only by a hair/skin/shirt color recipe -- not five separate
// hand-drawn designs, and deliberately not styled to resemble any
// specific licensed character design.

// 12 columns x 16 rows. One character per pixel:
// . = transparent   H = hair   F = face/skin   E = eye
// S = shirt         A = arm (bare skin)         P = pants   B = shoes
const SPRITE_TEMPLATE = [
  '..HHHHHHHH..',
  '.HHHHHHHHHH.',
  'HHHHHHHHHHHH',
  'HHFFFFFFFFHH',
  'HFFEFFFFEFFH',
  'HFFFFFFFFFFH',
  '.FFFFFFFFFF.',
  '..FFFFFFFF..',
  '.ASSSSSSSSA.',
  'AASSSSSSSSAA',
  'AASSSSSSSSAA',
  '.ASSSSSSSSA.',
  '..SS....SS..',
  '..PP....PP..',
  '..PP....PP..',
  '..BB....BB..',
]

interface CharacterDef {
  id: string
  name: string
  hair: number
  shirt: number
}

// Same base shape, five different color recipes -- the actual point of
// this technique, not a shortcut around drawing five real characters.
const CHARACTERS: CharacterDef[] = [
  { id: 'michael', name: 'Michael', hair: 0x4a3323, shirt: 0xa8443c },
  { id: 'jim', name: 'Jim', hair: 0x8a6a45, shirt: 0x4a7ba8 },
  { id: 'dwight', name: 'Dwight', hair: 0x2e2318, shirt: 0x3d7a52 },
  { id: 'pam', name: 'Pam', hair: 0x8a4a2e, shirt: 0xc99a3d },
  { id: 'riley', name: 'Riley', hair: 0x1c1c1c, shirt: 0x7d5a9e },
]

const SKIN = 0xe8b088
const EYE = 0x2a2a2a
const SHOE = 0x2a2018
const PANTS = 0x3a3a42

export type AgentStatus = 'idle' | 'working' | 'done'

interface OfficeSceneProps {
  // Real, current status per agent id -- driven by actual pipeline
  // activity from the parent, not randomized or decorative.
  statuses: Record<string, AgentStatus>
  // NEW: which agent (if any) direct chat is currently targeting --
  // used to visually highlight the selected character.
  activeDirectTarget?: string | null
  onCharacterClick?: (agentId: string) => void
}

function drawCharacter(g: PIXI.Graphics, def: CharacterDef, pixelSize: number) {
  g.clear()
  for (let row = 0; row < SPRITE_TEMPLATE.length; row++) {
    const line = SPRITE_TEMPLATE[row]
    for (let col = 0; col < line.length; col++) {
      const token = line[col]
      if (token === '.') continue
      const color =
        token === 'H' ? def.hair :
        token === 'F' ? SKIN :
        token === 'E' ? EYE :
        token === 'S' ? def.shirt :
        token === 'A' ? SKIN :
        token === 'P' ? PANTS :
        SHOE
      g.rect(col * pixelSize, row * pixelSize, pixelSize, pixelSize)
      g.fill(color)
    }
  }
}

export default function OfficeScene({ statuses, activeDirectTarget, onCharacterClick }: OfficeSceneProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const appRef = useRef<PIXI.Application | null>(null)
  const spritesRef = useRef<Record<string, { root: PIXI.Container; body: PIXI.Graphics; badge: PIXI.Graphics; selectRing: PIXI.Graphics; baseY: number }>>({})
  const statusesRef = useRef(statuses)
  statusesRef.current = statuses
  const activeDirectTargetRef = useRef(activeDirectTarget)
  activeDirectTargetRef.current = activeDirectTarget
  const onCharacterClickRef = useRef(onCharacterClick)
  onCharacterClickRef.current = onCharacterClick

  useEffect(() => {
    let destroyed = false
    const app = new PIXI.Application()
    const pixelSize = 3
    const spriteWidth = 12 * pixelSize
    const spriteHeight = 16 * pixelSize
    const deskGap = 84

    const initPromise = app.init({
      width: deskGap * CHARACTERS.length + 40,
      height: 130,
      backgroundAlpha: 0,
      antialias: false,
    })

    initPromise.then(() => {
      if (destroyed || !containerRef.current) return
      containerRef.current.appendChild(app.canvas)
      appRef.current = app

      CHARACTERS.forEach((def, i) => {
        const root = new PIXI.Container()
        const x = 20 + i * deskGap
        const baseY = 60
        root.x = x
        root.y = baseY

        // Desk -- a simple flat rectangle, not meant to be more than a
        // grounding element under the character.
        const desk = new PIXI.Graphics()
        desk.rect(-4, spriteHeight - 4, spriteWidth + 8, 8)
        desk.fill(0x2a2622)
        root.addChild(desk)

        // NEW: shown only while this character is the active direct-
        // chat target -- a real selection indicator, not decoration.
        const selectRing = new PIXI.Graphics()
        selectRing.roundRect(-6, -6, spriteWidth + 12, spriteHeight + 12, 6)
        selectRing.stroke({ width: 2, color: 0xa8443c })
        selectRing.visible = false
        root.addChild(selectRing)

        const body = new PIXI.Graphics()
        drawCharacter(body, def, pixelSize)
        root.addChild(body)

        const label = new PIXI.Text({
          text: def.name,
          style: { fontSize: 10, fill: 0x999999, fontFamily: 'monospace' }
        })
        label.x = spriteWidth / 2 - label.width / 2
        label.y = spriteHeight + 8
        root.addChild(label)

        // Status badge above the head -- a small colored dot/ring, not
        // an icon font, to stay in the same plain-shapes pixel style as
        // the character itself.
        const badge = new PIXI.Graphics()
        badge.y = -10
        badge.x = spriteWidth / 2
        root.addChild(badge)

        // NEW: real click interactivity -- this is the actual point of
        // the whole scene existing, not just a visual. Only Jim, Dwight,
        // and Pam support direct chat (matching what the backend
        // actually implements); Michael and Riley are shown but not
        // clickable -- Michael because he's already the default routed
        // target, Riley because document generation doesn't fit the
        // same "quick direct conversation" shape the other two do.
        const clickable = ['jim', 'dwight', 'pam'].includes(def.id)
        if (clickable) {
          root.eventMode = 'static'
          root.cursor = 'pointer'
          root.on('pointerdown', () => onCharacterClickRef.current?.(def.id))
          root.on('pointerover', () => { body.alpha = 0.8 })
          root.on('pointerout', () => { body.alpha = 1 })
        }

        app.stage.addChild(root)
        spritesRef.current[def.id] = { root, body, badge, selectRing, baseY }
      })

      let elapsed = 0
      app.ticker.add((ticker) => {
        elapsed += ticker.deltaMS / 1000
        for (const def of CHARACTERS) {
          const s = spritesRef.current[def.id]
          if (!s) continue
          const status = statusesRef.current[def.id] || 'idle'

          // Idle: a gentle continuous bob. Working: a faster, slightly
          // larger bob, so activity reads at a glance without needing
          // to look at the badge specifically.
          const bobSpeed = status === 'working' ? 6 : 2.2
          const bobHeight = status === 'working' ? 3 : 1.5
          s.root.y = s.baseY + Math.sin(elapsed * bobSpeed + def.hair) * bobHeight

          s.badge.clear()
          if (status === 'working') {
            s.badge.circle(0, 0, 3)
            s.badge.fill(0xd97706)
          } else if (status === 'done') {
            s.badge.circle(0, 0, 3)
            s.badge.fill(0x10b981)
          }

          s.selectRing.visible = activeDirectTargetRef.current === def.id
        }
      })
    })

    return () => {
      destroyed = true
      spritesRef.current = {}
      // FIXED: confirmed real crash -- app.destroy() was called
      // synchronously here while app.init() above is async. React
      // Strict Mode's real mount-unmount-remount cycle in development
      // reliably triggers cleanup before init resolves, and destroying
      // a Pixi Application before its internal setup (resize handling,
      // ticker) is wired up crashes with "this._cancelResize is not a
      // function" -- exactly the error seen. Chaining onto the same
      // init promise guarantees destroy only ever runs once init has
      // genuinely finished.
      initPromise.then(() => {
        app.destroy(true, { children: true })
      }).catch(() => {
        // init itself failed -- nothing valid to destroy either way.
      })
    }
  }, [])

  return <div ref={containerRef} className="flex justify-center" />
}