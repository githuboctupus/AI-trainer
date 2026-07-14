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
  isolateIds,
  isolateEnabled,
  muscleColors,
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
      const visible = !hiddenIds.has(id) && (!isolateEnabled || isolateIds.has(id))
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
        else if (id === selectedMuscle?.id) material.color.lerp(WHITE, 0.3)

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
    isolateIds,
    isolateEnabled,
    muscleColors,
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

  useFrame(() => {
    if (!request || handledToken.current === request.token) return

    const controls = controlsRef.current
    const mesh = request.muscle?.mesh
    if (!controls || !mesh || !mesh.visible) return

    mesh.updateWorldMatrix(true, false)
    const box = new THREE.Box3().setFromObject(mesh)
    if (box.isEmpty()) return

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

    controls.target.copy(center)
    camera.position.copy(center).add(direction.multiplyScalar(distance))
    camera.position.y = center.y
    camera.near = Math.max(distance / 100, 0.001)
    camera.far = Math.max(distance * 100, 100)
    camera.updateProjectionMatrix()
    camera.lookAt(center)
    controls.update()

    handledToken.current = request.token
  })

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

function MuscleDetails({
  muscle,
  isHidden,
  isIsolated,
  selectedColor,
  onToggleHidden,
  onToggleIsolated,
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
          onClick={onToggleIsolated}
          style={{
            ...styles.button,
            background: isIsolated ? 'rgba(37, 99, 235, 0.45)' : styles.button.background,
          }}
        >
          {isIsolated ? 'Remove isolated' : 'Add to isolated'}
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

function App() {
  const [skeletonOpacity, setSkeletonOpacity] = useState(1)
  const [anatomyOpacity, setAnatomyOpacity] = useState(0.75)
  const [muscles, setMuscles] = useState([])
  const [selectedMuscle, setSelectedMuscle] = useState(null)
  const [hoveredId, setHoveredId] = useState(null)
  const [hiddenIds, setHiddenIds] = useState(() => new Set())
  const [isolateIds, setIsolateIds] = useState(() => new Set())
  const [isolateEnabled, setIsolateEnabled] = useState(false)
  const [muscleColors, setMuscleColors] = useState({})
  const [searchText, setSearchText] = useState('')
  const [focusRequest, setFocusRequest] = useState(null)

  const controlsRef = useRef()
  const focusToken = useRef(0)

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

    if (isolateEnabled) {
      setIsolateIds((current) => new Set(current).add(id))
    }

    setSearchText('')
    selectMuscle(muscle, true)
  }

  const toggleSelectedHidden = () => {
    if (!selectedMuscle) return

    setHiddenIds((current) => {
      const next = new Set(current)
      next.has(selectedMuscle.id) ? next.delete(selectedMuscle.id) : next.add(selectedMuscle.id)
      return next
    })
    setHoveredId(null)
  }

  const toggleSelectedIsolated = () => {
    if (!selectedMuscle) return

    setIsolateIds((current) => {
      const next = new Set(current)
      next.has(selectedMuscle.id) ? next.delete(selectedMuscle.id) : next.add(selectedMuscle.id)
      return next
    })
  }

  const changeSelectedColor = (color) => {
    if (!selectedMuscle) return
    setMuscleColors((current) => ({ ...current, [selectedMuscle.id]: color }))
  }

  const focusSelectedMuscle = () => {
    if (!selectedMuscle) return

    setHiddenIds((current) => {
      const next = new Set(current)
      next.delete(selectedMuscle.id)
      return next
    })

    if (isolateEnabled) {
      setIsolateIds((current) => new Set(current).add(selectedMuscle.id))
    }

    requestFocus(selectedMuscle)
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
                  isolateIds={isolateIds}
                  isolateEnabled={isolateEnabled}
                  muscleColors={muscleColors}
                  onReady={setMuscles}
                  onSelect={selectMuscle}
                  onHover={setHoveredId}
                />
              </group>
            </Center>
          </Bounds>
        </Suspense>

        <OrbitControls ref={controlsRef} makeDefault minDistance={0.05} maxDistance={12} />
        <CameraFocus request={focusRequest} controlsRef={controlsRef} />
      </Canvas>

      <aside style={styles.panel}>
        <div style={{ fontSize: 19, fontWeight: 700, marginBottom: 14 }}>Muscle Explorer</div>

        <SearchBox
          value={searchText}
          results={searchResults}
          onChange={setSearchText}
          onChoose={chooseSearchResult}
        />

        <RangeControl label="Skeleton opacity" value={skeletonOpacity} onChange={setSkeletonOpacity} />
        <RangeControl label="Muscles opacity" value={anatomyOpacity} onChange={setAnatomyOpacity} />

        <div style={{ ...styles.card, margin: '14px 0' }}>
          <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, cursor: 'pointer' }}>
            <span>
              <strong>Render isolated</strong>
              <div style={{ ...styles.muted, fontSize: 11, marginTop: 2 }}>
                {isolateIds.size} muscle{isolateIds.size === 1 ? '' : 's'} in list
              </div>
            </span>
            <input
              type="checkbox"
              checked={isolateEnabled}
              onChange={(event) => setIsolateEnabled(event.target.checked)}
            />
          </label>

          {isolateIds.size > 0 && (
            <button
              type="button"
              onClick={() => setIsolateIds(new Set())}
              style={{ ...styles.button, width: '100%', marginTop: 9 }}
            >
              Clear isolated list
            </button>
          )}
        </div>

        {hiddenIds.size > 0 && (
          <button
            type="button"
            onClick={() => setHiddenIds(new Set())}
            style={{ ...styles.button, width: '100%', marginBottom: 14 }}
          >
            Show all hidden muscles ({hiddenIds.size})
          </button>
        )}

        <MuscleDetails
          muscle={selectedMuscle}
          isHidden={selectedMuscle ? hiddenIds.has(selectedMuscle.id) : false}
          isIsolated={selectedMuscle ? isolateIds.has(selectedMuscle.id) : false}
          selectedColor={selectedMuscle ? muscleColors[selectedMuscle.id] ?? 'original' : 'original'}
          onToggleHidden={toggleSelectedHidden}
          onToggleIsolated={toggleSelectedIsolated}
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