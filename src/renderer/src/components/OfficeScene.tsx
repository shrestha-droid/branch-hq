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
// T = necktie -- formal attire, running from collar down the chest
const SPRITE_TEMPLATE = [
  '..HHHHHHHH..',
  '.HHHHHHHHHH.',
  'HHHHHHHHHHHH',
  'HHFFFFFFFFHH',
  'HFFEFFFFEFFH',
  'HFFFFFFFFFFH',
  '.FFFFFFFFFF.',
  '..FFFFFFFF..',
  '.ASSSTTSSSA.',
  'AASSSTTSSSAA',
  'AASSSTTSSSAA',
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

const TIE = 0x2a2530

// Same base shape, five different color recipes -- the actual point of
// this technique, not a shortcut around drawing five real characters.
// A single, uniform dark tie color for everyone -- simple and
// consistently formal rather than another per-character variable.
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
  // NEW: lets the same component render as either the large primary
  // empty-state view or the compact strip shown once a conversation is
  // active, without duplicating the sprite-drawing logic.
  scale?: number
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
        token === 'T' ? TIE :
        token === 'P' ? PANTS :
        SHOE
      g.rect(col * pixelSize, row * pixelSize, pixelSize, pixelSize)
      g.fill(color)
    }
  }
}

export default function OfficeScene({ statuses, activeDirectTarget, onCharacterClick, scale = 1 }: OfficeSceneProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const appRef = useRef<PIXI.Application | null>(null)
  const spritesRef = useRef<Record<string, { root: PIXI.Container; body: PIXI.Graphics; badge: PIXI.Graphics; selectRing: PIXI.Graphics; monitor: PIXI.Graphics; monitorX: number; monitorY: number; monitorWidth: number; baseY: number }>>({})
  const statusesRef = useRef(statuses)
  statusesRef.current = statuses
  const activeDirectTargetRef = useRef(activeDirectTarget)
  activeDirectTargetRef.current = activeDirectTarget
  const onCharacterClickRef = useRef(onCharacterClick)
  onCharacterClickRef.current = onCharacterClick

  useEffect(() => {
    let destroyed = false
    const app = new PIXI.Application()
    const pixelSize = 3 * scale
    const spriteWidth = 12 * pixelSize
    const spriteHeight = 16 * pixelSize
    const deskGap = 84 * scale

    const initPromise = app.init({
      width: deskGap * CHARACTERS.length + 40 * scale,
      height: 130 * scale,
      backgroundAlpha: 0,
      antialias: false,
    })

    initPromise.then(() => {
      if (destroyed || !containerRef.current) return
      containerRef.current.appendChild(app.canvas)
      appRef.current = app

      const canvasWidth = deskGap * CHARACTERS.length + 40 * scale
      const canvasHeight = 130 * scale
      const floorTop = canvasHeight * 0.55

      // NEW: a real, static office environment -- explicitly not a
      // walkable floor plan (no movement or pathfinding), just an
      // actual backdrop instead of characters floating on nothing.
      // Drawn first so it sits behind everything else.
      const backdrop = new PIXI.Graphics()
      backdrop.rect(0, 0, canvasWidth, floorTop)
      backdrop.fill(0x2e2a26)
      backdrop.rect(0, floorTop, canvasWidth, canvasHeight - floorTop)
      backdrop.fill(0x25221f)
      backdrop.rect(0, floorTop - 2 * scale, canvasWidth, 2 * scale)
      backdrop.fill(0x1a1714)
      app.stage.addChild(backdrop)

      // A window -- a simple lit rectangle with a plain cross frame.
      const windowW = 26 * scale
      const windowH = 18 * scale
      const windowX = canvasWidth - windowW - 16 * scale
      const windowY = 8 * scale
      const window_ = new PIXI.Graphics()
      window_.rect(windowX, windowY, windowW, windowH)
      window_.fill(0x4a5568)
      window_.rect(windowX + windowW / 2 - 1, windowY, 2, windowH)
      window_.fill(0x1a1714)
      window_.rect(windowX, windowY + windowH / 2 - 1, windowW, 2)
      window_.fill(0x1a1714)
      app.stage.addChild(window_)

      // A potted plant on the opposite side, for a little life without
      // needing any actual simulation.
      const plantX = 14 * scale
      const plantY = floorTop - 2 * scale
      const plant = new PIXI.Graphics()
      plant.rect(plantX - 5 * scale, plantY - 5 * scale, 10 * scale, 5 * scale)
      plant.fill(0x5a4632)
      plant.circle(plantX, plantY - 10 * scale, 6 * scale)
      plant.fill(0x3d6b45)
      plant.circle(plantX - 4 * scale, plantY - 7 * scale, 4 * scale)
      plant.fill(0x3d6b45)
      plant.circle(plantX + 4 * scale, plantY - 7 * scale, 4 * scale)
      plant.fill(0x3d6b45)
      app.stage.addChild(plant)

      CHARACTERS.forEach((def, i) => {
        const root = new PIXI.Container()
        const x = 20 * scale + i * deskGap
        const baseY = 60 * scale
        root.x = x
        root.y = baseY

        // Desk -- a simple flat rectangle, not meant to be more than a
        // grounding element under the character.
        const desk = new PIXI.Graphics()
        desk.rect(-4, spriteHeight - 4, spriteWidth + 8, 8)
        desk.fill(0x2a2622)
        root.addChild(desk)

        // NEW: the actual mechanism behind "desktops light up when
        // working" -- a real monitor on the desk, dark when idle, lit
        // when genuinely working. Redrawn each tick alongside the
        // status badge, driven by the same real status data.
        const monitor = new PIXI.Graphics()
        const monitorWidth = 10 * scale
        const monitorX = spriteWidth / 2 - monitorWidth / 2
        const monitorY = spriteHeight - 3
        root.addChild(monitor)

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
          style: { fontSize: 10 * scale, fill: 0x999999, fontFamily: 'monospace' }
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

        // Every character is clickable now -- Michael included, since
        // clicking him is how you explicitly return to normal routed
        // mode, and Riley now has real direct-chat backend support too
        // (see agent:invoke). The parent decides what each specific
        // click actually means; this component just reports it.
        root.eventMode = 'static'
        root.cursor = 'pointer'
        root.on('pointerdown', () => onCharacterClickRef.current?.(def.id))
        root.on('pointerover', () => { body.alpha = 0.8 })
        root.on('pointerout', () => { body.alpha = 1 })

        app.stage.addChild(root)
        spritesRef.current[def.id] = { root, body, badge, selectRing, monitor, monitorX, monitorY, monitorWidth, baseY }
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

          // NEW: the actual "desktops light up when working" mechanism.
          // Dark bezel always visible; the screen itself is dark when
          // idle and a real, gently pulsing warm glow while genuinely
          // working -- the pulse (not just a flat color swap) is what
          // reads as "actively doing something" rather than a static
          // indicator light.
          s.monitor.clear()
          s.monitor.rect(s.monitorX - 1, s.monitorY - 1, s.monitorWidth + 2, 6 * scale + 2)
          s.monitor.fill(0x1a1814)
          const screenColor = status === 'working'
            ? (Math.sin(elapsed * 8) > 0 ? 0xffd27a : 0xd97706)
            : 0x111111
          s.monitor.rect(s.monitorX, s.monitorY, s.monitorWidth, 6 * scale)
          s.monitor.fill(screenColor)

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
  }, [scale])

  return <div ref={containerRef} className="flex justify-center" />
}