import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Bounds, Center, OrbitControls, useGLTF } from '@react-three/drei'
import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import {
  classifyMuscleGroup,
  getMuscleInfo,
  MUSCLE_GROUPS,
} from './muscleData'

const MODEL_SIZE = 2
const NO_RAYCAST = () => {}
const WHITE = new THREE.Color('#ffffff')

// AI command bar: talks to the backend in /server, which calls the
// Anthropic API with tool definitions and gets back tool_use blocks
// (see server/index.js for the exact tool schemas).
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8787'

// A stand-in for a real Claude API response, so the command bar can be
// tried out before ANTHROPIC_API_KEY is set up. This is the same shape
// server/index.js forwards for a real request: Claude's raw `content`
// array, with a short text block before each tool_use block. Wired to
// the "Try example" button below. Pretend prompt: "focus the right
// biceps, hide both hamstrings, then unhide the left one, and color
// the right quads red" — each step below runs one at a time.
const EXAMPLE_RESPONSE = {
  content: [
    { type: 'text', text: 'Focusing the right biceps.' },
    { type: 'tool_use', name: 'focus_muscle', input: { muscle: 'right biceps brachii' } },
    { type: 'text', text: 'Hiding the left hamstring.' },
    { type: 'tool_use', name: 'hide_muscle', input: { muscle: 'left biceps femoris' } },
    { type: 'text', text: 'Hiding the right hamstring.' },
    { type: 'tool_use', name: 'hide_muscle', input: { muscle: 'right biceps femoris' } },
    { type: 'text', text: 'Actually, showing the left hamstring again.' },
    { type: 'tool_use', name: 'show_muscle', input: { muscle: 'left biceps femoris' } },
    { type: 'text', text: 'Coloring the right quads red.' },
    { type: 'tool_use', name: 'set_muscle_color', input: { muscle: 'right rectus femoris', color: '#ef4444' } },
  ],
}

const COLOR_OPTIONS = [
  ['Original', 'original'],
  ['Red', '#ef4444'],
  ['Orange', '#f97316'],
  ['Yellow', '#eab308'],
  ['Green', '#22c55e'],
  ['Cyan', '#06b6d4'],
  ['Blue', '#3b82f6'],
  ['Purple', '#a855f7'],
  ['Pink', '#ec4899'],
]

const styles = {
  app: {
    width: '100vw',
    height: '100vh',
    position: 'relative',
    overflow: 'hidden',
    background: '#111827',
  },
  panel: {
    position: 'absolute',
    top: 16,
    left: 16,
    zIndex: 10,
    width: 340,
    maxHeight: 'calc(100vh - 32px)',
    overflowY: 'auto',
    boxSizing: 'border-box',
    padding: 16,
    borderRadius: 12,
    color: 'white',
    background: 'rgba(17, 24, 39, 0.94)',
    boxShadow: '0 14px 40px rgba(0, 0, 0, 0.35)',
    fontFamily: 'Arial, sans-serif',
    fontSize: 13,
  },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '9px 10px',
    border: '1px solid rgba(255, 255, 255, 0.2)',
    borderRadius: 7,
    color: 'white',
    background: 'rgba(255, 255, 255, 0.08)',
    outline: 'none',
  },
  button: {
    border: '1px solid rgba(255, 255, 255, 0.22)',
    borderRadius: 7,
    padding: '7px 10px',
    color: 'white',
    background: 'rgba(255, 255, 255, 0.08)',
    cursor: 'pointer',
  },
  card: {
    padding: 10,
    border: '1px solid rgba(255, 255, 255, 0.13)',
    borderRadius: 8,
  },
  muted: { color: '#9ca3af' },
}

function getMaterials(mesh) {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material]
}

function formatMuscleName(name) {
  const words = name
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')

  return words
    .map((word, index) => {
      const lower = word.toLowerCase()
      if (index > 0 && ['of', 'and', 'the'].includes(lower)) return lower
      return lower.charAt(0).toUpperCase() + lower.slice(1)
    })
    .join(' ')
}

// Matches a name from the AI (e.g. "left biceps brachii") to a loaded
// muscle record, using the same matching approach as the search box.
function resolveMuscle(muscleList, query) {
  if (!query) return null
  const q = query.trim().toLowerCase()
  if (!q) return null

  const candidates = muscleList.filter(
    (muscle) => muscle.searchName.includes(q) || muscle.name.toLowerCase().includes(q)
  )
  if (!candidates.length) return null

  candidates.sort((a, b) => {
    const aStarts = a.searchName.startsWith(q)
    const bStarts = b.searchName.startsWith(q)
    if (aStarts !== bStarts) return aStarts ? -1 : 1
    return a.displayName.localeCompare(b.displayName)
  })

  return candidates[0]
}

// Turns a Claude API response's content array into a list of steps —
// each step is the text Claude said right before a tool call, paired
// with that tool call. Used for both real backend responses and
// EXAMPLE_RESPONSE above.
function buildSteps(content) {
  if (!Array.isArray(content)) return []

  const steps = []
  let pendingText = ''

  for (const block of content) {
    if (block.type === 'text') {
      pendingText = block.text
    } else if (block.type === 'tool_use') {
      steps.push({ text: pendingText, toolCall: { name: block.name, input: block.input || {} } })
      pendingText = ''
    }
  }

  // No tool calls at all — Claude just replied with text, show it as one step.
  if (steps.length === 0 && pendingText) steps.push({ text: pendingText, toolCall: null })

  return steps
}

function cloneAndNormalize(scene) {
  const model = scene.clone(true)
  const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3())
  const largestDimension = Math.max(size.x, size.y, size.z)

  if (largestDimension > 0) {
    model.scale.multiplyScalar(MODEL_SIZE / largestDimension)
  }

  return model
}

function cloneMeshMaterials(mesh) {
  const materials = getMaterials(mesh).map((material) => material.clone())
  mesh.material = Array.isArray(mesh.material) ? materials : materials[0]
}

function makeMuscleRecord(mesh) {
  const groupKey = classifyMuscleGroup(mesh.name)
  const group = groupKey ? MUSCLE_GROUPS[groupKey] : null

  if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()

  const dimensions = mesh.geometry.boundingBox
    .getSize(new THREE.Vector3())
    .toArray()
    .map((value) => Number(value.toFixed(4)))

  const vertices = mesh.geometry.attributes.position?.count ?? 0
  const triangles = mesh.geometry.index
    ? Math.floor(mesh.geometry.index.count / 3)
    : Math.floor(vertices / 3)

  return {
    id: mesh.uuid,
    mesh,
    name: mesh.name,
    displayName: formatMuscleName(mesh.name),
    searchName: formatMuscleName(mesh.name).toLowerCase(),
    groupLabel: group?.label ?? 'Other',
    info: getMuscleInfo(mesh.name),
    vertices,
    triangles,
    dimensions,
  }
}

function prepareSkeleton(scene) {
  const model = cloneAndNormalize(scene)

  model.traverse((child) => {
    if (!child.isMesh) return

    cloneMeshMaterials(child)
    child.raycast = NO_RAYCAST

    getMaterials(child).forEach((material) => {
      material.transparent = true
    })
  })

  return model
}

function prepareAnatomy(scene) {
  const model = cloneAndNormalize(scene)
  const muscles = []

  model.traverse((child) => {
    if (!child.isMesh) return

    cloneMeshMaterials(child)
    child.userData.originalRaycast = child.raycast

    const groupKey = classifyMuscleGroup(child.name)
    const groupColor = groupKey ? MUSCLE_GROUPS[groupKey]?.color : null

    getMaterials(child).forEach((material) => {
      material.transparent = true
      if (groupColor && material.color) material.color.set(groupColor)
      if (material.color) material.userData.originalColor = material.color.clone()
    })

    const record = makeMuscleRecord(child)
    child.userData.muscle = record
    muscles.push(record)
  })

  model.userData.muscles = muscles
  return model
}

function setMeshVisible(mesh, visible) {
  mesh.visible = visible
  mesh.raycast = visible ? mesh.userData.originalRaycast : NO_RAYCAST
}

function SkeletonModel({ opacity }) {
  const { scene } = useGLTF('/skeleton.glb')
  const model = useMemo(() => prepareSkeleton(scene), [scene])

  useEffect(() => {
    model.traverse((child) => {
      if (!child.isMesh) return

      getMaterials(child).forEach((material) => {
        material.opacity = opacity
        material.depthWrite = opacity > 0.95
      })
    })
  }, [model, opacity])

  return <primitive object={model} />
}

function AnatomyModel({
  opacity,
  selectedMuscle,
  hoveredId,
  hiddenIds,
  muscleColors,
  selectedIds,
  showOnlySelected,
  highlightSelected,
  onReady,
  onSelect,
  onHover,
}) {
  const { scene } = useGLTF('/anatomy.glb')
  const model = useMemo(() => prepareAnatomy(scene), [scene])

  useEffect(() => {
    onReady(model.userData.muscles)
  }, [model, onReady])

  useEffect(() => {
    model.traverse((child) => {
      if (!child.isMesh) return

      const muscle = child.userData.muscle
      const id = muscle.id
      const visible = !hiddenIds.has(id) && (!showOnlySelected || selectedIds.has(id))
      setMeshVisible(child, visible)

      if (!visible) return

      getMaterials(child).forEach((material) => {
        if (!material.color) return

        const selectedColor = muscleColors[id]
        if (selectedColor && selectedColor !== 'original') {
          material.color.set(selectedColor)
        } else {
          material.color.copy(material.userData.originalColor)
        }

        if (id === hoveredId) material.color.lerp(WHITE, 0.58)
        else if (highlightSelected && (id === selectedMuscle?.id || selectedIds.has(id))) {
          material.color.lerp(WHITE, 0.3)
        }

        material.opacity = opacity
        material.depthWrite = opacity > 0.95
      })
    })
  }, [
    model,
    opacity,
    selectedMuscle,
    hoveredId,
    hiddenIds,
    muscleColors,
    selectedIds,
    showOnlySelected,
    highlightSelected,
  ])

  const muscleFromEvent = (event) => event.object?.userData?.muscle ?? null

  return (
    <primitive
      object={model}
      onClick={(event) => {
        const muscle = muscleFromEvent(event)
        if (!muscle || event.delta > 4) return
        event.stopPropagation()
        onSelect(muscle)
      }}
      onPointerMove={(event) => {
        const muscle = muscleFromEvent(event)
        if (!muscle) return
        event.stopPropagation()
        onHover(muscle.id)
      }}
      onPointerOut={() => onHover(null)}
    />
  )
}

function CameraFocus({ request, controlsRef }) {
  const { camera } = useThree()
  const handledToken = useRef(0)
  const anim = useRef(null) // { fromPosition, toPosition, fromTarget, toTarget, elapsed }
  const ZOOM_DURATION = 0.6 // seconds

  useFrame((_, delta) => {
    const controls = controlsRef.current
    if (!controls) return

    if (request && handledToken.current !== request.token) {
      const mesh = request.muscle?.mesh

      if (mesh && mesh.visible) {
        mesh.updateWorldMatrix(true, false)
        const box = new THREE.Box3().setFromObject(mesh)

        if (!box.isEmpty()) {
          const center = box.getCenter(new THREE.Vector3())
          const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 0.03)
          const direction = camera.position.clone().sub(controls.target)
          direction.y = 0

          if (direction.lengthSq() < 0.0001) direction.set(0, 0, 1)
          direction.normalize()

          const verticalFov = THREE.MathUtils.degToRad(camera.fov)
          const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect)
          const limitingFov = Math.min(verticalFov, horizontalFov)
          const distance = Math.max(radius / Math.sin(limitingFov / 2) * 1.35, 0.18)

          const toPosition = center.clone().add(direction.multiplyScalar(distance))
          toPosition.y = center.y

          // Near/far can jump immediately — only position and target are animated.
          camera.near = Math.max(distance / 100, 0.001)
          camera.far = Math.max(distance * 100, 100)
          camera.updateProjectionMatrix()

          anim.current = {
            fromPosition: camera.position.clone(),
            toPosition,
            fromTarget: controls.target.clone(),
            toTarget: center.clone(),
            elapsed: 0,
          }
        }
      }

      handledToken.current = request.token
    }

    if (anim.current) {
      const current = anim.current
      current.elapsed += delta
      const t = Math.min(current.elapsed / ZOOM_DURATION, 1)
      const eased = t * t * (3 - 2 * t) // smoothstep, so the zoom eases in/out instead of moving at constant speed

      camera.position.lerpVectors(current.fromPosition, current.toPosition, eased)
      controls.target.lerpVectors(current.fromTarget, current.toTarget, eased)
      camera.lookAt(controls.target)
      controls.update()

      if (t >= 1) anim.current = null
    }
  })

  return null
}

// Exposes the r3f camera to code outside the Canvas (drag-select needs it
// to project muscle positions to screen space).
function CameraRefSync({ cameraRef }) {
  const { camera } = useThree()

  useEffect(() => {
    cameraRef.current = camera
  }, [camera, cameraRef])

  return null
}

function RangeControl({ label, value, onChange }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label>{label}: {value.toFixed(2)}</label>
      <input
        type="range"
        min="0"
        max="1"
        step="0.01"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        style={{ width: '100%' }}
      />
    </div>
  )
}

function StatRow({ label, children }) {
  return (
    <div style={{ marginBottom: 8, lineHeight: 1.4 }}>
      <div style={{ ...styles.muted, fontSize: 11, textTransform: 'uppercase' }}>
        {label}
      </div>
      <div>{children}</div>
    </div>
  )
}

function SearchBox({ value, results, onChange, onChoose }) {
  return (
    <div style={{ position: 'relative', marginBottom: 14 }}>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search a muscle..."
        style={styles.input}
      />

      {value.trim() && (
        <div style={{
          position: 'absolute',
          top: 'calc(100% + 5px)',
          left: 0,
          right: 0,
          zIndex: 20,
          maxHeight: 230,
          overflowY: 'auto',
          border: '1px solid rgba(255, 255, 255, 0.16)',
          borderRadius: 8,
          background: '#1f2937',
          boxShadow: '0 12px 28px rgba(0, 0, 0, 0.4)',
        }}>
          {results.length ? results.map((muscle) => (
            <button
              key={muscle.id}
              type="button"
              onClick={() => onChoose(muscle)}
              style={{
                display: 'block',
                width: '100%',
                padding: '9px 10px',
                border: 0,
                borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                color: 'white',
                background: 'transparent',
                textAlign: 'left',
                cursor: 'pointer',
              }}
            >
              <div>{muscle.displayName}</div>
              <div style={{ ...styles.muted, fontSize: 11 }}>{muscle.groupLabel}</div>
            </button>
          )) : (
            <div style={{ padding: 10, ...styles.muted }}>No matching muscle</div>
          )}
        </div>
      )}
    </div>
  )
}

function AICommandBar({ value, status, message, hasNextStep, onChange, onSubmit, onTryExample, onNextStep, onDone }) {
  return (
    <div style={{ ...styles.card, marginBottom: 14 }}>
      <div style={{ ...styles.muted, fontSize: 11, textTransform: 'uppercase', marginBottom: 7 }}>
        Ask the AI
      </div>

      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            onSubmit()
          }
        }}
        placeholder='e.g. "hide the forearms and color the quads red"'
        rows={2}
        style={{ ...styles.input, resize: 'vertical', marginBottom: 8 }}
      />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <button
          type="button"
          onClick={onSubmit}
          disabled={status === 'loading'}
          style={styles.button}
        >
          {status === 'loading' ? 'Thinking…' : 'Send'}
        </button>

        <button type="button" onClick={onTryExample} style={styles.button}>
          Try example
        </button>
      </div>

      {message && (
        <div
          style={{
            marginTop: 8,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            fontSize: 12,
            color: status === 'error' ? '#f87171' : '#9ca3af',
          }}
        >
          <span>{message}</span>
          {hasNextStep ? (
            <button
              type="button"
              onClick={onNextStep}
              title="Next step"
              style={{ ...styles.button, padding: '2px 10px', flexShrink: 0 }}
            >
              →
            </button>
          ) : (
            <button
              type="button"
              onClick={onDone}
              style={{ ...styles.button, padding: '2px 10px', flexShrink: 0 }}
            >
              Done
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function MuscleDetails({
  muscle,
  isHidden,
  isSelected,
  selectedColor,
  onToggleHidden,
  onToggleSelected,
  onColorChange,
  onFocus,
  onDeselect,
}) {
  if (!muscle) {
    return (
      <div style={{ paddingTop: 12, borderTop: '1px solid rgba(255, 255, 255, 0.15)', ...styles.muted }}>
        Click a muscle or choose one from search to view its properties.
      </div>
    )
  }

  return (
    <section style={{ paddingTop: 14, borderTop: '1px solid rgba(255, 255, 255, 0.15)' }}>
      <div style={{ fontSize: 17, fontWeight: 700 }}>{muscle.displayName}</div>
      <div style={{ ...styles.muted, margin: '3px 0 12px' }}>{muscle.groupLabel}</div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
        <button type="button" onClick={onToggleHidden} style={styles.button}>
          {isHidden ? 'Show muscle' : 'Hide muscle'}
        </button>
        <button
          type="button"
          onClick={onToggleSelected}
          style={{
            ...styles.button,
            background: isSelected ? 'rgba(37, 99, 235, 0.45)' : styles.button.background,
          }}
        >
          {isSelected ? 'Remove from selected list' : 'Add to selected list'}
        </button>
      </div>

      <div style={{ marginBottom: 14 }}>
        <div style={{ ...styles.muted, fontSize: 11, textTransform: 'uppercase', marginBottom: 7 }}>
          Color
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
          {COLOR_OPTIONS.map(([label, value]) => {
            const active = selectedColor === value
            return (
              <button
                key={value}
                type="button"
                title={label}
                aria-label={label}
                onClick={() => onColorChange(value)}
                style={{
                  width: value === 'original' ? 58 : 25,
                  height: 25,
                  padding: 0,
                  border: active ? '2px solid white' : '1px solid rgba(255, 255, 255, 0.35)',
                  borderRadius: 6,
                  color: 'white',
                  background: value === 'original' ? 'rgba(255, 255, 255, 0.1)' : value,
                  cursor: 'pointer',
                  fontSize: 10,
                }}
              >
                {value === 'original' ? 'Original' : ''}
              </button>
            )
          })}
        </div>
      </div>

      <StatRow label="Origin">{muscle.info.origin}</StatRow>
      <StatRow label="Insertion">{muscle.info.insertion}</StatRow>
      <StatRow label="Action">{muscle.info.action}</StatRow>
      <StatRow label="Innervation">{muscle.info.innervation}</StatRow>
      {muscle.info.notes && <StatRow label="Notes">{muscle.info.notes}</StatRow>}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, paddingTop: 10, borderTop: '1px solid rgba(255, 255, 255, 0.12)' }}>
        <StatRow label="Vertices">{muscle.vertices.toLocaleString()}</StatRow>
        <StatRow label="Triangles">{muscle.triangles.toLocaleString()}</StatRow>
      </div>
      <StatRow label="Mesh dimensions">{muscle.dimensions.join(' × ')}</StatRow>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <button type="button" onClick={onFocus} style={styles.button}>
          Focus camera
        </button>

        <button type="button" onClick={onDeselect} style={styles.button}>
          Deselect
        </button>
      </div>
    </section>
  )
}

// One expandable tab per muscle in the "selected" list. Expanding a tab
// reuses MuscleDetails itself, bound to that muscle instead of the single
// selectedMuscle used elsewhere.
function SelectedMusclesPanel({
  selectedMuscles,
  expandedId,
  hiddenIds,
  muscleColors,
  onToggleExpand,
  onToggleHidden,
  onColorChange,
  onFocus,
  onRemove,
}) {
  if (selectedMuscles.length === 0) {
    return <div style={{ ...styles.muted, fontSize: 12 }}>No muscles selected yet.</div>
  }

  return (
    <div>
      {selectedMuscles.map((muscle) => {
        const expanded = expandedId === muscle.id
        return (
          <div key={muscle.id} style={{ borderTop: '1px solid rgba(255, 255, 255, 0.12)' }}>
            <div
              onClick={() => onToggleExpand(muscle.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 2px',
                cursor: 'pointer',
              }}
            >
              <span>{muscle.displayName}</span>
              <span style={{ ...styles.muted, fontSize: 14 }}>{expanded ? '▾' : '▸'}</span>
            </div>

            {expanded && (
              <MuscleDetails
                muscle={muscle}
                isHidden={hiddenIds.has(muscle.id)}
                isSelected
                selectedColor={muscleColors[muscle.id] ?? 'original'}
                onToggleHidden={() => onToggleHidden(muscle)}
                onToggleSelected={() => onRemove(muscle)}
                onColorChange={(color) => onColorChange(muscle, color)}
                onFocus={() => onFocus(muscle)}
                onDeselect={() => onRemove(muscle)}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

function App() {
  const [skeletonOpacity, setSkeletonOpacity] = useState(1)
  const [anatomyOpacity, setAnatomyOpacity] = useState(0.75)
  const [muscles, setMuscles] = useState([])
  const [selectedMuscle, setSelectedMuscle] = useState(null)
  const [hoveredId, setHoveredId] = useState(null)
  const [hiddenIds, setHiddenIds] = useState(() => new Set())
  const [muscleColors, setMuscleColors] = useState({})
  const [searchText, setSearchText] = useState('')
  const [focusRequest, setFocusRequest] = useState(null)
  const [commandText, setCommandText] = useState('')
  const [commandStatus, setCommandStatus] = useState(null) // null | 'loading' | 'error'
  const [commandMessage, setCommandMessage] = useState('')
  const [commandSteps, setCommandSteps] = useState([])
  const [stepIndex, setStepIndex] = useState(0)

  // "Selected muscles" list — separate from selectedMuscle (the single
  // muscle shown in the main details panel).
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [expandedSelectedId, setExpandedSelectedId] = useState(null)
  const [multiSelectMode, setMultiSelectMode] = useState(false)
  const [dragSelectMode, setDragSelectMode] = useState(false)
  const [showOnlySelected, setShowOnlySelected] = useState(false)
  const [highlightSelected, setHighlightSelected] = useState(true)
  const [dragBox, setDragBox] = useState(null) // {x0,y0,x1,y1} in overlay-local px, while dragging

  const controlsRef = useRef()
  const focusToken = useRef(0)
  const cameraRef = useRef()
  const overlayRef = useRef()

  const searchResults = useMemo(() => {
    const query = searchText.trim().toLowerCase()
    if (!query) return []

    return muscles
      .filter((muscle) => muscle.searchName.includes(query) || muscle.name.toLowerCase().includes(query))
      .sort((a, b) => {
        const aStarts = a.searchName.startsWith(query)
        const bStarts = b.searchName.startsWith(query)
        if (aStarts !== bStarts) return aStarts ? -1 : 1
        return a.displayName.localeCompare(b.displayName)
      })
      .slice(0, 12)
  }, [muscles, searchText])

  const requestFocus = (muscle) => {
    focusToken.current += 1
    setFocusRequest({ muscle, token: focusToken.current })
  }

  const selectMuscle = (muscle, focus = false) => {
    setSelectedMuscle(muscle)
    if (focus) requestFocus(muscle)
  }

  const chooseSearchResult = (muscle) => {
    const id = muscle.id
    setHiddenIds((current) => {
      const next = new Set(current)
      next.delete(id)
      return next
    })

    if (showOnlySelected) {
      setSelectedIds((current) => new Set(current).add(id))
    }

    setSearchText('')
    selectMuscle(muscle, true)
  }

  // Generic per-muscle actions, usable for any muscle — not just the one
  // currently shown in the main details panel. Shared by that panel and
  // by each expandable card in the "selected" list below.
  const toggleMuscleHidden = (muscle) => {
    setHiddenIds((current) => {
      const next = new Set(current)
      next.has(muscle.id) ? next.delete(muscle.id) : next.add(muscle.id)
      return next
    })
  }

  const setMuscleColor = (muscle, color) => {
    setMuscleColors((current) => ({ ...current, [muscle.id]: color }))
  }

  const toggleSelectedHidden = () => {
    if (!selectedMuscle) return
    toggleMuscleHidden(selectedMuscle)
    setHoveredId(null)
  }

  const toggleSelectedInList = () => {
    if (!selectedMuscle) return
    toggleSelectedId(selectedMuscle.id)
  }

  const changeSelectedColor = (color) => {
    if (!selectedMuscle) return
    setMuscleColor(selectedMuscle, color)
  }

  const focusSelectedMuscle = () => {
    if (!selectedMuscle) return

    setHiddenIds((current) => {
      const next = new Set(current)
      next.delete(selectedMuscle.id)
      return next
    })

    if (showOnlySelected) {
      setSelectedIds((current) => new Set(current).add(selectedMuscle.id))
    }

    requestFocus(selectedMuscle)
  }

  // The "selected" list — a separate group of muscles a user builds up via
  // multi-select clicking or drag-select, independent of selectedMuscle.
  const toggleSelectedId = (id) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const removeSelectedId = (id) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      next.delete(id)
      return next
    })
  }

  // What a muscle click does depends on whether multi-select mode is on.
  const handleMuscleClick = (muscle) => {
    if (multiSelectMode) toggleSelectedId(muscle.id)
    else selectMuscle(muscle, false)
  }

  // Drag-select: while active, an overlay over the canvas (see render below)
  // captures the drag instead of OrbitControls, and on release we project
  // each visible muscle's world position to screen space to see which ones
  // fall inside the drawn rectangle.
  const dragBoxPoint = (event) => {
    const rect = overlayRef.current.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  const startDragBox = (event) => {
    if (!dragSelectMode) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const point = dragBoxPoint(event)
    setDragBox({ x0: point.x, y0: point.y, x1: point.x, y1: point.y })
  }

  const updateDragBox = (event) => {
    if (!dragBox) return
    const point = dragBoxPoint(event)
    setDragBox((current) => ({ ...current, x1: point.x, y1: point.y }))
  }

  const finishDragBox = () => {
    if (!dragBox) return

    const camera = cameraRef.current
    const rect = overlayRef.current?.getBoundingClientRect()

    if (camera && rect) {
      const left = Math.min(dragBox.x0, dragBox.x1)
      const right = Math.max(dragBox.x0, dragBox.x1)
      const top = Math.min(dragBox.y0, dragBox.y1)
      const bottom = Math.max(dragBox.y0, dragBox.y1)

      const matches = []
      muscles.forEach((muscle) => {
        const mesh = muscle.mesh
        if (!mesh || !mesh.visible) return

        mesh.updateWorldMatrix(true, false)
        const box = new THREE.Box3().setFromObject(mesh)
        if (box.isEmpty()) return

        const center = box.getCenter(new THREE.Vector3()).project(camera)
        const x = (center.x * 0.5 + 0.5) * rect.width
        const y = (-center.y * 0.5 + 0.5) * rect.height

        if (x >= left && x <= right && y >= top && y <= bottom) matches.push(muscle.id)
      })

      if (matches.length) {
        setSelectedIds((current) => {
          const next = new Set(current)
          matches.forEach((id) => next.add(id))
          return next
        })
      }
    }

    setDragBox(null)
  }

  // Runs one Claude tool_use call using the same state setters the UI
  // buttons already use above. Returns an error string, or null on success.
  const runToolCall = ({ name, input }) => {
    const withMuscle = (fn) => {
      const muscle = resolveMuscle(muscles, input.muscle)
      if (!muscle) return `Couldn't find "${input.muscle}".`
      fn(muscle)
      return null
    }

    switch (name) {
      case 'select_muscle':
        return withMuscle((muscle) => selectMuscle(muscle, false))
      case 'focus_muscle':
        return withMuscle((muscle) => selectMuscle(muscle, true))
      case 'hide_muscle':
        return withMuscle((muscle) => setHiddenIds((current) => new Set(current).add(muscle.id)))
      case 'show_muscle':
        return withMuscle((muscle) =>
          setHiddenIds((current) => {
            const next = new Set(current)
            next.delete(muscle.id)
            return next
          })
        )
      // These keep their original tool names for the AI, but now operate on
      // the selected list / "show only selected" — isolate mode was removed
      // in favor of that.
      case 'add_to_isolated':
        return withMuscle((muscle) => setSelectedIds((current) => new Set(current).add(muscle.id)))
      case 'remove_from_isolated':
        return withMuscle((muscle) =>
          setSelectedIds((current) => {
            const next = new Set(current)
            next.delete(muscle.id)
            return next
          })
        )
      case 'set_muscle_color':
        return withMuscle((muscle) =>
          setMuscleColors((current) => ({ ...current, [muscle.id]: input.color || 'original' }))
        )
      case 'reset_muscle_color':
        return withMuscle((muscle) => setMuscleColors((current) => ({ ...current, [muscle.id]: 'original' })))
      case 'set_isolate_mode':
        setShowOnlySelected(Boolean(input.enabled))
        return null
      case 'clear_isolated_list':
        setSelectedIds(new Set())
        return null
      case 'show_all_muscles':
        setHiddenIds(new Set())
        return null
      case 'deselect_muscle':
        setSelectedMuscle(null)
        setHoveredId(null)
        return null
      default:
        return `Unknown tool "${name}".`
    }
  }

  // Runs one step's tool call (if it has one) and shows its text.
  const runStep = (step) => {
    const error = step.toolCall ? runToolCall(step.toolCall) : null
    setCommandMessage(error || step.text || 'Done.')
    setCommandStatus(error ? 'error' : null)
  }

  // Starts a new list of steps from a Claude response's content array,
  // running only the first one — the rest wait for the "next" arrow.
  const beginSteps = (content) => {
    const steps = buildSteps(content)
    setCommandSteps(steps)
    setStepIndex(0)
    if (steps.length > 0) runStep(steps[0])
  }

  const goToNextStep = () => {
    const next = stepIndex + 1
    if (next >= commandSteps.length) return
    setStepIndex(next)
    runStep(commandSteps[next])
  }

  // Dismisses the AI's output once its steps are done.
  const clearCommand = () => {
    setCommandMessage('')
    setCommandStatus(null)
    setCommandSteps([])
    setStepIndex(0)
  }

  const submitCommand = async () => {
    const text = commandText.trim()
    if (!text || commandStatus === 'loading') return

    setCommandStatus('loading')
    setCommandMessage('')

    try {
      const response = await fetch(`${API_BASE_URL}/api/interpret`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: text, muscles: muscles.map((muscle) => muscle.displayName) }),
      })

      if (!response.ok) throw new Error(`Request failed (${response.status})`)

      const data = await response.json()
      beginSteps(data.content)
      setCommandText('')
    } catch (err) {
      setCommandStatus('error')
      setCommandMessage(err.message || 'Something went wrong.')
    }
  }

  // Runs EXAMPLE_RESPONSE through the exact same path a real API response
  // takes, so the command bar can be tried without ANTHROPIC_API_KEY set up.
  const tryExample = () => {
    beginSteps(EXAMPLE_RESPONSE.content)
  }

  return (
    <div style={styles.app}>
      <Canvas camera={{ fov: 50, position: [0, 0, 4] }}>
        <color attach="background" args={['#111827']} />
        <ambientLight intensity={0.9} />
        <directionalLight position={[5, 5, 5]} intensity={1.1} />
        <directionalLight position={[-5, 2, -3]} intensity={0.45} />

        <Suspense fallback={null}>
          <Bounds fit clip margin={1.18}>
            <Center>
              <group rotation={[-Math.PI / 2, 0, 0]}>
                <SkeletonModel opacity={skeletonOpacity} />
                <AnatomyModel
                  opacity={anatomyOpacity}
                  selectedMuscle={selectedMuscle}
                  hoveredId={hoveredId}
                  hiddenIds={hiddenIds}
                  muscleColors={muscleColors}
                  selectedIds={selectedIds}
                  showOnlySelected={showOnlySelected}
                  highlightSelected={highlightSelected}
                  onReady={setMuscles}
                  onSelect={handleMuscleClick}
                  onHover={setHoveredId}
                />
              </group>
            </Center>
          </Bounds>
        </Suspense>

        <OrbitControls ref={controlsRef} makeDefault enabled={!dragSelectMode} minDistance={0.05} maxDistance={12} />
        <CameraFocus request={focusRequest} controlsRef={controlsRef} />
        <CameraRefSync cameraRef={cameraRef} />
      </Canvas>

      <div
        ref={overlayRef}
        onPointerDown={startDragBox}
        onPointerMove={updateDragBox}
        onPointerUp={finishDragBox}
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: 5,
          pointerEvents: dragSelectMode ? 'auto' : 'none',
          cursor: dragSelectMode ? 'crosshair' : 'default',
        }}
      >
        {dragBox && (
          <div
            style={{
              position: 'absolute',
              left: Math.min(dragBox.x0, dragBox.x1),
              top: Math.min(dragBox.y0, dragBox.y1),
              width: Math.abs(dragBox.x1 - dragBox.x0),
              height: Math.abs(dragBox.y1 - dragBox.y0),
              border: '1px solid #38bdf8',
              background: 'rgba(56, 189, 248, 0.15)',
            }}
          />
        )}
      </div>

      <aside style={styles.panel}>
        <div style={{ fontSize: 19, fontWeight: 700, marginBottom: 14 }}>Muscle Explorer</div>

        <SearchBox
          value={searchText}
          results={searchResults}
          onChange={setSearchText}
          onChoose={chooseSearchResult}
        />

        <AICommandBar
          value={commandText}
          status={commandStatus}
          message={commandMessage}
          hasNextStep={stepIndex < commandSteps.length - 1}
          onChange={setCommandText}
          onSubmit={submitCommand}
          onTryExample={tryExample}
          onNextStep={goToNextStep}
          onDone={clearCommand}
        />

        <RangeControl label="Skeleton opacity" value={skeletonOpacity} onChange={setSkeletonOpacity} />
        <RangeControl label="Muscles opacity" value={anatomyOpacity} onChange={setAnatomyOpacity} />

        <div style={{ ...styles.card, margin: '14px 0' }}>
          <span>
            <strong>Hidden muscles</strong>
            <div style={{ ...styles.muted, fontSize: 11, marginTop: 2 }}>
              {hiddenIds.size} muscle{hiddenIds.size === 1 ? '' : 's'} hidden
            </div>
          </span>

          {hiddenIds.size > 0 && (
            <button
              type="button"
              onClick={() => setHiddenIds(new Set())}
              style={{ ...styles.button, width: '100%', marginTop: 9 }}
            >
              Clear hidden list
            </button>
          )}
        </div>

        <div style={{ ...styles.card, marginBottom: 14 }}>
          <span>
            <strong>Selected muscles</strong>
            <div style={{ ...styles.muted, fontSize: 11, marginTop: 2 }}>
              {selectedIds.size} muscle{selectedIds.size === 1 ? '' : 's'} selected
            </div>
          </span>

          <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, cursor: 'pointer', marginTop: 9, marginBottom: 7 }}>
            <span>Multi-select (click adds to list)</span>
            <input
              type="checkbox"
              checked={multiSelectMode}
              onChange={(event) => setMultiSelectMode(event.target.checked)}
            />
          </label>

          <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, cursor: 'pointer', marginBottom: 7 }}>
            <span>Drag-select (draw a box)</span>
            <input
              type="checkbox"
              checked={dragSelectMode}
              onChange={(event) => setDragSelectMode(event.target.checked)}
            />
          </label>

          <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, cursor: 'pointer', marginBottom: 7 }}>
            <span>Show only selected</span>
            <input
              type="checkbox"
              checked={showOnlySelected}
              onChange={(event) => setShowOnlySelected(event.target.checked)}
            />
          </label>

          <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, cursor: 'pointer', marginBottom: 9 }}>
            <span>Highlight selected</span>
            <input
              type="checkbox"
              checked={highlightSelected}
              onChange={(event) => setHighlightSelected(event.target.checked)}
            />
          </label>

          {selectedIds.size > 0 && (
            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              style={{ ...styles.button, width: '100%', marginBottom: 9 }}
            >
              Clear selected list
            </button>
          )}

          <SelectedMusclesPanel
            selectedMuscles={muscles.filter((muscle) => selectedIds.has(muscle.id))}
            expandedId={expandedSelectedId}
            hiddenIds={hiddenIds}
            muscleColors={muscleColors}
            onToggleExpand={(id) => setExpandedSelectedId((current) => (current === id ? null : id))}
            onToggleHidden={toggleMuscleHidden}
            onColorChange={setMuscleColor}
            onFocus={requestFocus}
            onRemove={(muscle) => removeSelectedId(muscle.id)}
          />
        </div>

        <MuscleDetails
          muscle={selectedMuscle}
          isHidden={selectedMuscle ? hiddenIds.has(selectedMuscle.id) : false}
          isSelected={selectedMuscle ? selectedIds.has(selectedMuscle.id) : false}
          selectedColor={selectedMuscle ? muscleColors[selectedMuscle.id] ?? 'original' : 'original'}
          onToggleHidden={toggleSelectedHidden}
          onToggleSelected={toggleSelectedInList}
          onColorChange={changeSelectedColor}
          onFocus={focusSelectedMuscle}
          onDeselect={() => {
            setSelectedMuscle(null)
            setHoveredId(null)
          }}
        />
      </aside>
    </div>
  )
}

useGLTF.preload('/skeleton.glb')
useGLTF.preload('/anatomy.glb')

export default App