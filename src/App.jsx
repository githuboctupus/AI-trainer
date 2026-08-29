import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Bounds, Center, OrbitControls, useGLTF } from '@react-three/drei'
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import {
  classifyMuscleGroup,
  getMuscleInfo,
  MUSCLE_GROUPS,
} from './muscleData'

const NO_RAYCAST = () => {}
const WHITE = new THREE.Color('#ffffff')

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8787'

const MODEL_CONFIGS = [
  {
    key: 'bones',
    label: 'Bones',
    sourceLabel: 'Skeleton',
    url: '/skeleton_final.glb',
    defaultCategory: 'Bone',
    initialOpacity: 1,
  },
  {
    key: 'muscles',
    label: 'Muscles',
    sourceLabel: 'Muscle model',
    url: '/muscle_final.glb',
    defaultCategory: 'Muscle',
    initialOpacity: 0.75,
  },
  {
    key: 'joints',
    label: 'Joints & ligaments',
    sourceLabel: 'Joint model',
    url: '/joints_final.glb',
    defaultCategory: null,
    initialOpacity: 1,
  },
]

const EXAMPLE_RESPONSE = {
  content: [
    {
      type: 'text',
      text: 'Focusing the right clavicular part of the deltoid.',
    },
    {
      type: 'tool_use',
      name: 'focus_structure',
      input: { structure: 'right clavicular part of deltoid muscle' },
    },
    {
      type: 'text',
      text: 'Coloring the right supraspinatus blue.',
    },
    {
      type: 'tool_use',
      name: 'set_structure_color',
      input: {
        structure: 'right supraspinatus muscle',
        color: '#3b82f6',
      },
    },
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
  if (!mesh.material) return []
  return Array.isArray(mesh.material) ? mesh.material.filter(Boolean) : [mesh.material]
}

function cloneMeshMaterials(mesh) {
  const materials = getMaterials(mesh).map((material) => material.clone())
  mesh.material = Array.isArray(mesh.material) ? materials : materials[0]
}

function formatStructureName(name) {
  if (!name) return 'Unnamed structure'

  let cleaned = name.trim()
  let side = ''

  if (/(?:_right|\.r)$/i.test(cleaned)) {
    cleaned = cleaned.replace(/(?:_right|\.r)$/i, '')
    side = 'Right'
  } else if (/(?:_left|\.l)$/i.test(cleaned)) {
    cleaned = cleaned.replace(/(?:_left|\.l)$/i, '')
    side = 'Left'
  } else {
    cleaned = cleaned.replace(/(?:_g|\.g)$/i, '')
  }

  const words = cleaned
    .replace(/_+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')

  const title = words
    .map((word, index) => {
      const lower = word.toLowerCase()
      if (index > 0 && ['of', 'and', 'the'].includes(lower)) return lower
      return lower.charAt(0).toUpperCase() + lower.slice(1)
    })
    .join(' ')

  return side ? `${side} ${title}` : title
}

function getHierarchyText(object) {
  const names = []
  let current = object

  while (current && names.length < 10) {
    if (current.name) names.push(current.name)
    current = current.parent
  }

  return names.join(' ').toLowerCase()
}

function classifyJointCategory(mesh) {
  const name = (mesh.name || '').toLowerCase()
  const context = getHierarchyText(mesh)

  // Use the mesh's own name first. Parent names are only a fallback.
  if (name.includes('capsule')) return 'Joint Capsule'
  if (name.includes('ligament') || name.includes('ligamentum')) return 'Ligament'
  if (name.includes('membrane')) return 'Membrane'
  if (name.includes('retinaculum')) return 'Retinaculum'
  if (name.includes('meniscus')) return 'Meniscus'
  if (
    name.includes('articular disc') ||
    name.includes('intervertebral disc') ||
    name.includes('nucleus pulposus') ||
    /\bdisc\b/.test(name)
  ) {
    return 'Articular Disc'
  }
  if (name.includes('cartilage') || name.includes('labrum')) return 'Cartilage'
  if (name.includes('tendon')) return 'Tendon'
  if (name.includes('bursa')) return 'Bursa'

  if (context.includes('capsule')) return 'Joint Capsule'
  if (context.includes('ligament') || context.includes('ligamentum')) return 'Ligament'
  if (context.includes('membrane')) return 'Membrane'
  if (context.includes('meniscus')) return 'Meniscus'
  if (context.includes('disc') || context.includes('nucleus pulposus')) return 'Articular Disc'
  if (context.includes('cartilage') || context.includes('labrum')) return 'Cartilage'

  if (
    context.includes('joint') ||
    context.includes('articulation') ||
    context.includes('suture') ||
    context.includes('syndesmosis') ||
    context.includes('symphysis') ||
    context.includes('synchondrosis') ||
    context.includes('gomphosis') ||
    context.includes('synostosis')
  ) {
    return 'Joint'
  }

  return 'Joint Structure'
}

function getGeometryStats(mesh) {
  const geometry = mesh.geometry

  if (!geometry) {
    return { vertices: 0, triangles: 0, dimensions: [0, 0, 0] }
  }

  if (!geometry.boundingBox) geometry.computeBoundingBox()

  const dimensions = geometry.boundingBox
    ? geometry.boundingBox
        .getSize(new THREE.Vector3())
        .toArray()
        .map((value) => Number(value.toFixed(4)))
    : [0, 0, 0]

  const vertices = geometry.attributes.position?.count ?? 0
  const triangles = geometry.index
    ? Math.floor(geometry.index.count / 3)
    : Math.floor(vertices / 3)

  return { vertices, triangles, dimensions }
}

function getStructureStats(meshes) {
  const box = new THREE.Box3()
  let vertices = 0
  let triangles = 0

  meshes.forEach((mesh) => {
    const stats = getGeometryStats(mesh)
    vertices += stats.vertices
    triangles += stats.triangles
    box.expandByObject(mesh)
  })

  const dimensions = box.isEmpty()
    ? [0, 0, 0]
    : box
        .getSize(new THREE.Vector3())
        .toArray()
        .map((value) => Number(value.toFixed(4)))

  return { vertices, triangles, dimensions }
}

function makeStructureRecord(
  owner,
  meshes,
  config,
  fallbackIndex,
  nodeMetadata = {},
) {
  const representativeMesh = meshes[0]

  const rawName = (
    nodeMetadata.ownerName?.trim() ||
    owner.name?.trim() ||
    representativeMesh?.name?.trim() ||
    `Unnamed ${config.defaultCategory || 'structure'} ${fallbackIndex}`
  )

  const displayName = formatStructureName(rawName)

  const category = config.key === 'joints'
    ? classifyJointCategory(owner)
    : config.defaultCategory

  const groupKey = category === 'Muscle'
    ? classifyMuscleGroup(rawName)
    : null

  const muscleGroup = groupKey
    ? MUSCLE_GROUPS[groupKey]
    : null

  const groupLabel = muscleGroup?.label ?? null
  const stats = getStructureStats(meshes)

  const structureId = `${config.key}:object:${owner.uuid}`

  return {
    id: structureId,

    object: owner,
    mesh: representativeMesh,
    meshes,

    nodeIndex: nodeMetadata.nodeIndex ?? null,
    meshIndex: nodeMetadata.meshIndex ?? null,
    ownerName: nodeMetadata.ownerName ?? null,

    name: rawName,
    displayName,
    displayLabel: `${displayName} — ${category}`,

    searchName: [
      displayName,
      rawName,
      category,
      config.label,
      groupLabel || '',
    ]
      .join(' ')
      .toLowerCase(),

    category,
    groupLabel,
    sourceKey: config.key,
    sourceLabel: config.sourceLabel,

    info: category === 'Muscle'
      ? getMuscleInfo(rawName)
      : null,

    ...stats,
  }
}

function prepareMeshForInteraction(mesh) {
  if (!mesh.userData.aiTrainerMaterialsPrepared) {
    cloneMeshMaterials(mesh)
    mesh.userData.aiTrainerMaterialsPrepared = true
  }

  if (!mesh.userData.originalRaycast) {
    mesh.userData.originalRaycast = mesh.raycast
  }
}

function buildStructureEntries(scene, associations) {
  const entriesByOwner = new Map()
  const fallbackEntries = []

  scene.traverse((mesh) => {
    if (!mesh.isMesh) return

    prepareMeshForInteraction(mesh)

    let owner = mesh
    let ownerAssociation = associations?.get(owner)

    /*
     * Walk upward to the nearest Three.js object corresponding to a glTF node.
     *
     * Important: group by the actual owner object, not association.nodes.
     * In this model, separate left/right owners can incorrectly report the
     * same node index through parser.associations.
     */
    while (
      owner &&
      (!ownerAssociation || ownerAssociation.nodes === undefined)
    ) {
      owner = owner.parent
      ownerAssociation = owner
        ? associations?.get(owner)
        : null
    }

    if (!owner || !ownerAssociation) {
      fallbackEntries.push({
        object: mesh,
        meshes: [mesh],
        nodeIndex: null,
        meshIndex: null,
        ownerName: mesh.name || null,
      })

      return
    }

    let entry = entriesByOwner.get(owner)

    if (!entry) {
      entry = {
        object: owner,
        meshes: [],
        nodeIndex: ownerAssociation.nodes ?? null,
        meshIndex: ownerAssociation.meshes ?? null,
        ownerName: owner.name || null,
      }

      entriesByOwner.set(owner, entry)
    }

    if (!entry.meshes.includes(mesh)) {
      entry.meshes.push(mesh)
    }
  })

  return [
    ...entriesByOwner.values(),
    ...fallbackEntries,
  ]
}

function prepareModel(scene, config, associations) {
  const model = scene
  const entries = buildStructureEntries(model, associations)
  const structures = []
  entries.forEach((entry, index) => {
    const {
      object,
      meshes,
      nodeIndex,
      meshIndex,
      ownerName,
    } = entry

    const rawName = (
      ownerName?.trim() ||
      object.name?.trim() ||
      meshes[0]?.name?.trim() ||
      ''
    )

    const muscleGroupKey = config.key === 'muscles'
      ? classifyMuscleGroup(rawName)
      : null

    const muscleGroupColor = muscleGroupKey
      ? MUSCLE_GROUPS[muscleGroupKey]?.color
      : null

    meshes.forEach((mesh) => {
      getMaterials(mesh).forEach((material) => {
        if (muscleGroupColor && material.color) {
          material.color.set(muscleGroupColor)
        }

        if (
          material.color &&
          !material.userData.originalColor
        ) {
          material.userData.originalColor =
            material.color.clone()
        }
      })
    })

    const record = makeStructureRecord(
      object,
      meshes,
      config,
      index + 1,
      {
        nodeIndex,
        meshIndex,
        ownerName,
      },
    )

    /*
     * Every render piece inside this glTF node points to the same complete
     * anatomical structure.
     */
    meshes.forEach((mesh) => {
      mesh.userData.structure = record
    })

    structures.push(record)
  })

  model.userData.structures = structures

  return model
}

function findStructureForMesh(model, mesh) {
  if (!mesh?.isMesh) return null

  return model.userData.structures?.find(
    (structure) => structure.meshes.includes(mesh),
  ) ?? null
}

function setMeshVisible(mesh, visible) {
  mesh.visible = visible
  mesh.raycast = visible ? mesh.userData.originalRaycast : NO_RAYCAST
}

function resolveStructure(structureList, query, requiredCategory = null) {
  if (!query) return null

  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return null

  const candidates = structureList.filter((structure) => {
    if (requiredCategory && structure.category !== requiredCategory) return false

    return (
      structure.searchName.includes(normalizedQuery) ||
      structure.name.toLowerCase().includes(normalizedQuery) ||
      structure.displayLabel.toLowerCase().includes(normalizedQuery)
    )
  })

  if (!candidates.length) return null

  candidates.sort((a, b) => {
    const aExact = a.displayName.toLowerCase() === normalizedQuery || a.name.toLowerCase() === normalizedQuery
    const bExact = b.displayName.toLowerCase() === normalizedQuery || b.name.toLowerCase() === normalizedQuery
    if (aExact !== bExact) return aExact ? -1 : 1

    const aStarts = a.searchName.startsWith(normalizedQuery)
    const bStarts = b.searchName.startsWith(normalizedQuery)
    if (aStarts !== bStarts) return aStarts ? -1 : 1

    return a.displayLabel.localeCompare(b.displayLabel)
  })

  return candidates[0]
}

function buildSteps(content) {
  if (!Array.isArray(content)) return []

  const steps = []
  let pendingText = ''

  for (const block of content) {
    if (block.type === 'text') {
      pendingText = block.text
    } else if (block.type === 'tool_use') {
      steps.push({
        text: pendingText,
        toolCall: { name: block.name, input: block.input || {} },
      })
      pendingText = ''
    }
  }

  if (steps.length === 0 && pendingText) {
    steps.push({ text: pendingText, toolCall: null })
  }

  return steps
}

function StructureModel({
  config,
  opacity,
  selectedStructure,
  hoveredId,
  hiddenIds,
  structureColors,
  selectedIds,
  showOnlySelected,
  highlightSelected,
  onReady,
  onSelect,
  onHover,
  customGroups,
  showOnlyCustomGroupName,
}) {
  const { scene, parser } = useGLTF(config.url)
  const model = useMemo(
    () => prepareModel(scene, config, parser.associations),
    [scene, config, parser],
  )

  useEffect(() => {
    onReady(config.key, model.userData.structures)
  }, [config.key, model, onReady])

  useEffect(() => {
    model.traverse((child) => {
      if (!child.isMesh) return

      const structure = child.userData.structure
      if (!structure) return

      const id = structure.id
      const customGroupIds = showOnlyCustomGroupName
        ? customGroups[showOnlyCustomGroupName]
        : null

      const visible = (
        opacity > 0 &&
        !hiddenIds.has(id) &&
        (!showOnlySelected || selectedIds.has(id)) &&
        (!customGroupIds || customGroupIds.has(id))
      )

      setMeshVisible(child, visible)
      if (!visible) return

      getMaterials(child).forEach((material) => {
        if (material.color) {
          const selectedColor = structureColors[id]

          if (selectedColor && selectedColor !== 'original') {
            material.color.set(selectedColor)
          } else if (material.userData.originalColor) {
            material.color.copy(material.userData.originalColor)
          }

          if (
            highlightSelected &&
            structure === selectedStructure
          ) {
            material.color.lerp(WHITE, 0.3)
          }
        }

        const isTransparent = opacity < 0.999
        material.transparent = isTransparent
        material.opacity = opacity
        material.depthWrite = !isTransparent
        material.needsUpdate = true
      })
    })
  }, [
    model,
    opacity,
    selectedStructure,
    hoveredId,
    hiddenIds,
    structureColors,
    selectedIds,
    showOnlySelected,
    highlightSelected,
    customGroups,
    showOnlyCustomGroupName,
  ])

  const getEventStructure = (event) => (
    findStructureForMesh(model, event.object)
  )

  return (
    <primitive
      object={model}
      onClick={(event) => {
        if (event.delta > 4) return

        const structure = getEventStructure(event)
        if (!structure) return

        const counterpartName = structure.displayName.startsWith('Left ')
          ? structure.displayName.replace(/^Left /, 'Right ')
          : structure.displayName.startsWith('Right ')
            ? structure.displayName.replace(/^Right /, 'Left ')
            : null

        const counterpart = counterpartName
          ? model.userData.structures?.find(
              (candidate) => candidate.displayName === counterpartName,
            )
          : null

        console.log('CLICK COMPARISON', {
          clicked: {
            meshName: event.object.name,
            meshUUID: event.object.uuid,
            parentName: event.object.parent?.name,
            parentUUID: event.object.parent?.uuid,

            structureName: structure.displayName,
            structureId: structure.id,
            nodeIndex: structure.nodeIndex,
            objectUUID: structure.object?.uuid,

            meshes: structure.meshes.map((mesh) => ({
              name: mesh.name,
              uuid: mesh.uuid,
              parentName: mesh.parent?.name,
              geometryUUID: mesh.geometry?.uuid,
              materialUUIDs: getMaterials(mesh).map(
                (material) => material.uuid,
              ),
            })),
          },
          parentAssociations: (() => {
            const results = []

            model.traverse((object) => {
              if (
                object.name === 'Clavicular_part_of_deltoid_muscle_left' ||
                object.name === 'Clavicular_part_of_deltoid_muscle_right'
              ) {
                results.push({
                  name: object.name,
                  uuid: object.uuid,
                  association: parser.associations.get(object) ?? null,
                  childMeshes: object.children
                    .filter((child) => child.isMesh)
                    .map((child) => ({
                      name: child.name,
                      uuid: child.uuid,
                      association: parser.associations.get(child) ?? null,
                    })),
                })
              }
            })

            return results
          })(),
          counterpart: counterpart
            ? {
                structureName: counterpart.displayName,
                structureId: counterpart.id,
                nodeIndex: counterpart.nodeIndex,
                objectUUID: counterpart.object?.uuid,

                sameStructureObject: counterpart === structure,
                sameOwnerObject: counterpart.object === structure.object,

                meshes: counterpart.meshes.map((mesh) => ({
                  name: mesh.name,
                  uuid: mesh.uuid,
                  parentName: mesh.parent?.name,
                  geometryUUID: mesh.geometry?.uuid,
                  materialUUIDs: getMaterials(mesh).map(
                    (material) => material.uuid,
                  ),
                })),

                sharedMeshObjects: counterpart.meshes.filter(
                  (mesh) => structure.meshes.includes(mesh),
                ).map((mesh) => mesh.uuid),

                sharedMaterialObjects: counterpart.meshes.flatMap(
                  (counterpartMesh) =>
                    getMaterials(counterpartMesh)
                      .filter((counterpartMaterial) =>
                        structure.meshes.some((selectedMesh) =>
                          getMaterials(selectedMesh).includes(counterpartMaterial),
                        ),
                      )
                      .map((material) => material.uuid),
                ),
              }
            : null,
        })

        event.stopPropagation()
        onSelect(structure)
      }}
      onPointerOver={() => {}}
      onPointerOut={() => {}}
    />
  )
}

function CameraFocus({ request, controlsRef }) {
  const { camera } = useThree()
  const handledToken = useRef(0)
  const animation = useRef(null)
  const zoomDuration = 0.6

  useFrame((_, delta) => {
    const controls = controlsRef.current
    if (!controls) return

    if (request && handledToken.current !== request.token) {
      const mesh = request.structure?.object ?? request.structure?.mesh
      let requestHandled = false

      if (mesh && mesh.visible) {
        mesh.updateWorldMatrix(true, false)
        const box = new THREE.Box3().setFromObject(mesh)

        if (!box.isEmpty()) {
          const center = box.getCenter(new THREE.Vector3())
          const radius = Math.max(
            box.getBoundingSphere(new THREE.Sphere()).radius,
            0.03,
          )

          const direction = camera.position.clone().sub(controls.target)
          direction.y = 0
          if (direction.lengthSq() < 0.0001) direction.set(0, 0, 1)
          direction.normalize()

          const verticalFov = THREE.MathUtils.degToRad(camera.fov)
          const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect)
          const limitingFov = Math.min(verticalFov, horizontalFov)
          const distance = Math.max(
            (radius / Math.sin(limitingFov / 2)) * 1.35,
            0.18,
          )

          const toPosition = center.clone().add(direction.multiplyScalar(distance))
          toPosition.y = center.y

          camera.near = Math.max(distance / 100, 0.001)
          camera.far = Math.max(distance * 100, 100)
          camera.updateProjectionMatrix()

          animation.current = {
            fromPosition: camera.position.clone(),
            toPosition,
            fromTarget: controls.target.clone(),
            toTarget: center.clone(),
            elapsed: 0,
          }
          requestHandled = true
        }
      }

      // A hidden structure may become visible after React applies an unhide
      // or show-only-selected update. Retry on the next frame until it is ready.
      if (requestHandled) handledToken.current = request.token
    }

    if (!animation.current) return

    const current = animation.current
    current.elapsed += delta

    const progress = Math.min(current.elapsed / zoomDuration, 1)
    const eased = progress * progress * (3 - 2 * progress)

    camera.position.lerpVectors(current.fromPosition, current.toPosition, eased)
    controls.target.lerpVectors(current.fromTarget, current.toTarget, eased)
    camera.lookAt(controls.target)
    controls.update()

    if (progress >= 1) animation.current = null
  })

  return null
}

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
      <label>{label} opacity: {value.toFixed(2)}</label>
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
        placeholder="Search bones, muscles, joints, ligaments..."
        style={styles.input}
      />

      {value.trim() && (
        <div
          style={{
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
          }}
        >
          {results.length ? results.map((structure) => (
            <button
              key={structure.id}
              type="button"
              onClick={() => onChoose(structure)}
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
              <div>{structure.displayLabel}</div>
              <div style={{ ...styles.muted, fontSize: 11 }}>
                {structure.groupLabel || structure.sourceLabel}
              </div>
            </button>
          )) : (
            <div style={{ padding: 10, ...styles.muted }}>
              No matching structure
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function AICommandBar({
  value,
  status,
  message,
  hasNextStep,
  onChange,
  onSubmit,
  onTryExample,
  onNextStep,
  onDone,
}) {
  return (
    <div style={{ ...styles.card, marginBottom: 14 }}>
      <div
        style={{
          ...styles.muted,
          fontSize: 11,
          textTransform: 'uppercase',
          marginBottom: 7,
        }}
      >
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
        placeholder='e.g. "focus on the right clavicular part of the deltoid muscle and color the right supraspinatus blue"'
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

function StructureDetails({
  structure,
  isHidden,
  isSelected,
  selectedColor,
  customGroups,
  onAddToGroup,
  onToggleHidden,
  onToggleSelected,
  onColorChange,
  onFocus,
  onDeselect,
}) {
  const [selectedGroupName, setSelectedGroupName] = useState('')
  if (!structure) {
    return (
      <div
        style={{
          paddingTop: 12,
          borderTop: '1px solid rgba(255, 255, 255, 0.15)',
          ...styles.muted,
        }}
      >
        Click a structure or choose one from search to view its properties.
      </div>
    )
  }

  return (
    <section
      style={{
        paddingTop: 14,
        borderTop: '1px solid rgba(255, 255, 255, 0.15)',
      }}
    >
      <div style={{ fontSize: 17, fontWeight: 700 }}>{structure.displayName}</div>
      <div style={{ ...styles.muted, margin: '3px 0 12px' }}>
        {structure.category}
        {structure.groupLabel ? ` · ${structure.groupLabel}` : ''}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 8,
          marginBottom: 12,
        }}
      >
        <button type="button" onClick={onToggleHidden} style={styles.button}>
          {isHidden ? 'Show structure' : 'Hide structure'}
        </button>

        <button
          type="button"
          onClick={onToggleSelected}
          style={{
            ...styles.button,
            background: isSelected
              ? 'rgba(37, 99, 235, 0.45)'
              : styles.button.background,
          }}
        >
          {isSelected ? 'Remove from selected list' : 'Add to selected list'}
        </button>
      </div>
      {Object.keys(customGroups).length > 0 && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
          <select
            value={selectedGroupName}
            onChange={(event) => setSelectedGroupName(event.target.value)}
            style={{
              ...styles.input,
              marginBottom: 0,
              background: '#1f1f1f',
              color: '#fff',
            }}
          >
            <option value="" style={{ background: '#1f1f1f', color: '#fff' }}>
              Select custom group...
            </option>

            {Object.keys(customGroups).map((groupName) => (
              <option
                key={groupName}
                value={groupName}
                style={{ background: '#1f1f1f', color: '#fff' }}
              >
                {groupName}
              </option>
            ))}
          </select>

          <button
            type="button"
            disabled={!selectedGroupName}
            onClick={() => {
              onAddToGroup(selectedGroupName)
              setSelectedGroupName('')
            }}
            style={styles.button}
          >
            Add
          </button>
        </div>
      )}
      <div style={{ marginBottom: 14 }}>
        <div
          style={{
            ...styles.muted,
            fontSize: 11,
            textTransform: 'uppercase',
            marginBottom: 7,
          }}
        >
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
                  border: active
                    ? '2px solid white'
                    : '1px solid rgba(255, 255, 255, 0.35)',
                  borderRadius: 6,
                  color: 'white',
                  background: value === 'original'
                    ? 'rgba(255, 255, 255, 0.1)'
                    : value,
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

      <StatRow label="Category">{structure.category}</StatRow>
      <StatRow label="Source model">{structure.sourceLabel}</StatRow>
      <StatRow label="Original object name">{structure.name}</StatRow>

      {structure.category === 'Muscle' && structure.info && (
        <>
          <StatRow label="Origin">{structure.info.origin}</StatRow>
          <StatRow label="Insertion">{structure.info.insertion}</StatRow>
          <StatRow label="Action">{structure.info.action}</StatRow>
          <StatRow label="Innervation">{structure.info.innervation}</StatRow>
          {structure.info.notes && (
            <StatRow label="Notes">{structure.info.notes}</StatRow>
          )}
        </>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 8,
          paddingTop: 10,
          borderTop: '1px solid rgba(255, 255, 255, 0.12)',
        }}
      >
        <StatRow label="Vertices">{structure.vertices.toLocaleString()}</StatRow>
        <StatRow label="Triangles">{structure.triangles.toLocaleString()}</StatRow>
      </div>

      <StatRow label="Mesh dimensions">
        {structure.dimensions.join(' × ')}
      </StatRow>

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

function SelectedStructuresPanel({
  selectedStructures,
  expandedId,
  hiddenIds,
  structureColors,
  customGroups,
  onAddToGroup,
  onToggleExpand,
  onToggleHidden,
  onColorChange,
  onFocus,
  onRemove,
}) {
  if (selectedStructures.length === 0) {
    return (
      <div style={{ ...styles.muted, fontSize: 12 }}>
        No structures selected yet.
      </div>
    )
  }

  return (
    <div>
      {selectedStructures.map((structure) => {
        const expanded = expandedId === structure.id

        return (
          <div
            key={structure.id}
            style={{ borderTop: '1px solid rgba(255, 255, 255, 0.12)' }}
          >
            <div
              onClick={() => onToggleExpand(structure.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 2px',
                cursor: 'pointer',
              }}
            >
              <span>{structure.displayLabel}</span>
              <span style={{ ...styles.muted, fontSize: 14 }}>
                {expanded ? '▾' : '▸'}
              </span>
            </div>

            {expanded && (
              <StructureDetails
                structure={structure}
                isHidden={hiddenIds.has(structure.id)}
                isSelected
                selectedColor={structureColors[structure.id] ?? 'original'}
                onToggleHidden={() => onToggleHidden(structure)}
                onToggleSelected={() => onRemove(structure)}
                onColorChange={(color) => onColorChange(structure, color)}
                onFocus={() => onFocus(structure)}
                onDeselect={() => onRemove(structure)}
                customGroups={customGroups}
                onAddToGroup={(groupName) =>
                  onAddToGroup(groupName, structure.id)
                }
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

function App() {
  const [modelOpacities, setModelOpacities] = useState(() => Object.fromEntries(
    MODEL_CONFIGS.map((config) => [config.key, config.initialOpacity]),
  ))
  const [structuresByModel, setStructuresByModel] = useState({})
  const [selectedStructure, setSelectedStructure] = useState(null)
  const [hoveredId, setHoveredId] = useState(null)
  const [hiddenIds, setHiddenIds] = useState(() => new Set())
  const [structureColors, setStructureColors] = useState({})
  const [searchText, setSearchText] = useState('')
  const [focusRequest, setFocusRequest] = useState(null)

  const [commandText, setCommandText] = useState('')
  const [commandStatus, setCommandStatus] = useState(null)
  const [commandMessage, setCommandMessage] = useState('')
  const [commandSteps, setCommandSteps] = useState([])
  const [stepIndex, setStepIndex] = useState(0)

  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [customGroups, setCustomGroups] = useState({})
  const [newGroupName, setNewGroupName] = useState('')
  const [showOnlyCustomGroupName, setShowOnlyCustomGroupName] = useState(null)
  const [expandedSelectedId, setExpandedSelectedId] = useState(null)
  const [multiSelectMode, setMultiSelectMode] = useState(false)
  const [dragSelectMode, setDragSelectMode] = useState(false)
  const [showOnlySelected, setShowOnlySelected] = useState(false)
  const [highlightSelected, setHighlightSelected] = useState(true)
  const [dragBox, setDragBox] = useState(null)

  const controlsRef = useRef()
  const focusToken = useRef(0)
  const cameraRef = useRef()
  const overlayRef = useRef()

  const handleModelReady = useCallback((modelKey, modelStructures) => {
    setStructuresByModel((current) => {
      if (current[modelKey] === modelStructures) return current
      return { ...current, [modelKey]: modelStructures }
    })
  }, [])

  const structures = useMemo(
    () => MODEL_CONFIGS.flatMap((config) => structuresByModel[config.key] || []),
    [structuresByModel],
  )

  const muscles = useMemo(
    () => structures.filter((structure) => structure.category === 'Muscle'),
    [structures],
  )

  const selectedStructures = useMemo(
    () => structures.filter((structure) => selectedIds.has(structure.id)),
    [structures, selectedIds],
  )
  const hiddenStructures = useMemo(
    () => structures.filter((structure) => hiddenIds.has(structure.id)),
    [structures, hiddenIds],
  )

  const coloredStructures = useMemo(
    () => structures.filter(
      (structure) =>
        structureColors[structure.id] &&
        structureColors[structure.id] !== 'original',
    ),
    [structures, structureColors],
  )

  const searchResults = useMemo(() => {
    const query = searchText.trim().toLowerCase()
    if (!query) return []

    return structures
      .filter((structure) => (
        structure.searchName.includes(query) ||
        structure.name.toLowerCase().includes(query) ||
        structure.displayLabel.toLowerCase().includes(query)
      ))
      .sort((a, b) => {
        const aStarts = a.searchName.startsWith(query)
        const bStarts = b.searchName.startsWith(query)
        if (aStarts !== bStarts) return aStarts ? -1 : 1
        return a.displayLabel.localeCompare(b.displayLabel)
      })
      .slice(0, 12)
  }, [structures, searchText])

  const setModelOpacity = (modelKey, opacity) => {
    setModelOpacities((current) => ({ ...current, [modelKey]: opacity }))
  }

  const requestFocus = (structure) => {
    focusToken.current += 1
    setFocusRequest({ structure, token: focusToken.current })
  }

  const selectStructure = (structure) => {
    setSelectedStructure(structure)
  }

  const focusStructure = (structure) => {
    if (!structure) return

    setHiddenIds((current) => {
      const next = new Set(current)
      next.delete(structure.id)
      return next
    })

    if (showOnlySelected) {
      setSelectedIds((current) => new Set(current).add(structure.id))
    }

    setSelectedStructure(structure)
    requestFocus(structure)
  }

  const chooseSearchResult = (structure) => {
    setSearchText('')
    focusStructure(structure)
  }

  const toggleStructureHidden = (structure) => {
    setHiddenIds((current) => {
      const next = new Set(current)
      next.has(structure.id)
        ? next.delete(structure.id)
        : next.add(structure.id)
      return next
    })
  }

  const setStructureColor = (structure, color) => {
    setStructureColors((current) => {
      const next = { ...current }

      if (!color || color === 'original') {
        delete next[structure.id]
      } else {
        next[structure.id] = color
      }

      return next
    })
  }

  const toggleSelectedHidden = () => {
    if (!selectedStructure) return
    toggleStructureHidden(selectedStructure)
    setHoveredId(null)
  }

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
  const createCustomGroup = () => {
    const name = newGroupName.trim()
    if (!name || customGroups[name]) return

    setCustomGroups((current) => ({
      ...current,
      [name]: new Set(),
    }))

    setNewGroupName('')
  }

  const addStructureToGroup = (groupName, structureId) => {
    setCustomGroups((current) => ({
      ...current,
      [groupName]: new Set([
        ...(current[groupName] || []),
        structureId,
      ]),
    }))
  }

  const removeStructureFromGroup = (groupName, structureId) => {
    setCustomGroups((current) => {
      const nextGroup = new Set(current[groupName])
      nextGroup.delete(structureId)

      return {
        ...current,
        [groupName]: nextGroup,
      }
    })
  }

  const deleteCustomGroup = (groupName) => {
    setCustomGroups((current) => {
      const next = { ...current }
      delete next[groupName]
      return next
    })
  }

  const selectCustomGroup = (groupName) => {
    setSelectedIds(new Set(customGroups[groupName] || []))
  }

  const hideCustomGroup = (groupName) => {
    setHiddenIds((current) => {
      const next = new Set(current)

      customGroups[groupName]?.forEach((id) => next.add(id))

      return next
    })
  }

  const showCustomGroup = (groupName) => {
    setHiddenIds((current) => {
      const next = new Set(current)

      customGroups[groupName]?.forEach((id) => next.delete(id))

      return next
    })
  }

  const toggleShowOnlyCustomGroup = (groupName) => {
    setShowOnlyCustomGroupName((current) =>
      current === groupName ? null : groupName
    )
  }
  const toggleSelectedInList = () => {
    if (!selectedStructure) return
    toggleSelectedId(selectedStructure.id)
  }

  const changeSelectedColor = (color) => {
    if (!selectedStructure) return
    setStructureColor(selectedStructure, color)
  }

  const focusSelectedStructure = () => {
    focusStructure(selectedStructure)
  }

  const handleStructureClick = (structure) => {
    setSelectedStructure(structure)

    if (multiSelectMode) {
      toggleSelectedId(structure.id)
    } else {
      setSelectedIds(new Set([structure.id]))
    }
  }

  const dragBoxPoint = (event) => {
    const rect = overlayRef.current?.getBoundingClientRect()
    if (!rect) return null

    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    }
  }

  const startDragBox = (event) => {
    if (!dragSelectMode) return

    const point = dragBoxPoint(event)
    if (!point) return

    event.currentTarget.setPointerCapture(event.pointerId)
    setDragBox({ x0: point.x, y0: point.y, x1: point.x, y1: point.y })
  }

  const updateDragBox = (event) => {
    if (!dragBox) return

    const point = dragBoxPoint(event)
    if (!point) return

    setDragBox((current) => (
      current ? { ...current, x1: point.x, y1: point.y } : current
    ))
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

      structures.forEach((structure) => {
        const mesh = structure.object ?? structure.mesh
        if (!mesh || !mesh.visible) return

        mesh.updateWorldMatrix(true, false)
        const box = new THREE.Box3().setFromObject(mesh)
        if (box.isEmpty()) return

        const center = box.getCenter(new THREE.Vector3()).project(camera)
        const x = (center.x * 0.5 + 0.5) * rect.width
        const y = (-center.y * 0.5 + 0.5) * rect.height

        if (x >= left && x <= right && y >= top && y <= bottom) {
          matches.push(structure.id)
        }
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

  const runToolCall = ({ name, input }) => {
    const structureQuery = input.structure ?? input.muscle

    const withStructure = (fn, requiredCategory = null) => {
      if (!structureQuery) return 'Missing structure name.'

      const structure = resolveStructure(structures, structureQuery, requiredCategory)
      if (!structure) return `Couldn't find "${structureQuery}".`

      fn(structure)
      return null
    }

    const showStructure = (structure) => {
      setHiddenIds((current) => {
        const next = new Set(current)
        next.delete(structure.id)
        return next
      })
    }

    const hideStructure = (structure) => {
      setHiddenIds((current) => new Set(current).add(structure.id))
    }

    switch (name) {
      // Existing muscle tool names are preserved for the current backend.
      case 'select_muscle':
        return withStructure((structure) => selectStructure(structure), 'Muscle')
      case 'focus_muscle':
        return withStructure((structure) => focusStructure(structure), 'Muscle')
      case 'hide_muscle':
        return withStructure(hideStructure, 'Muscle')
      case 'show_muscle':
        return withStructure(showStructure, 'Muscle')
      case 'set_muscle_color':
        return withStructure(
          (structure) => setStructureColor(structure, input.color || 'original'),
          'Muscle',
        )
      case 'reset_muscle_color':
        return withStructure(
          (structure) => setStructureColor(structure, 'original'),
          'Muscle',
        )

      // Generic aliases let the frontend support an anatomy-wide backend later.
      case 'select_structure':
        return withStructure((structure) => selectStructure(structure))
      case 'focus_structure':
        return withStructure((structure) => focusStructure(structure))
      case 'hide_structure':
        return withStructure(hideStructure)
      case 'show_structure':
        return withStructure(showStructure)
      case 'set_structure_color':
        return withStructure(
          (structure) => setStructureColor(structure, input.color || 'original'),
        )
      case 'reset_structure_color':
        return withStructure(
          (structure) => setStructureColor(structure, 'original'),
        )

      case 'add_to_isolated':
      case 'add_to_selected':
        return withStructure(
          (structure) => setSelectedIds((current) => new Set(current).add(structure.id)),
          input.structure ? null : 'Muscle',
        )
      case 'remove_from_isolated':
      case 'remove_from_selected':
        return withStructure(
          (structure) => {
            setSelectedIds((current) => {
              const next = new Set(current)
              next.delete(structure.id)
              return next
            })
          },
          input.structure ? null : 'Muscle',
        )
      case 'set_isolate_mode':
        setShowOnlySelected(Boolean(input.enabled))
        return null
      case 'clear_isolated_list':
      case 'clear_selected_list':
        setSelectedIds(new Set())
        return null
      case 'show_all_muscles':
        setHiddenIds((current) => {
          const muscleIds = new Set(muscles.map((muscle) => muscle.id))
          return new Set([...current].filter((id) => !muscleIds.has(id)))
        })
        return null
      case 'show_all_structures':
        setHiddenIds(new Set())
        return null
      case 'deselect_muscle':
        if (selectedStructure?.category === 'Muscle') {
          setSelectedStructure(null)
          setHoveredId(null)
        }
        return null
      case 'deselect_structure':
        setSelectedStructure(null)
        setHoveredId(null)
        return null
      default:
        return `Unknown tool "${name}".`
    }
  }

  const runStep = (step) => {
    const error = step.toolCall ? runToolCall(step.toolCall) : null
    setCommandMessage(error || step.text || 'Done.')
    setCommandStatus(error ? 'error' : null)
  }

  const beginSteps = (content) => {
    const steps = buildSteps(content)
    setCommandSteps(steps)
    setStepIndex(0)

    if (steps.length > 0) runStep(steps[0])
  }

  const goToNextStep = () => {
    const nextIndex = stepIndex + 1
    if (nextIndex >= commandSteps.length) return

    setStepIndex(nextIndex)
    runStep(commandSteps[nextIndex])
  }

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
        body: JSON.stringify({
          command: text,
          // Keep this field for the existing server.
          // muscles: muscles.map((muscle) => muscle.displayName),
          // // A future generic server can use this without another App.jsx change.
          // structures: structures.map((structure) => ({
          //   name: structure.displayName,
          //   category: structure.category,
          // })),
        }),
      })

      if (!response.ok) throw new Error(`Request failed (${response.status})`)

      const data = await response.json()
      beginSteps(data.content)
      setCommandText('')
    } catch (error) {
      setCommandStatus('error')
      setCommandMessage(error.message || 'Something went wrong.')
    }
  }

  const tryExample = () => {
    beginSteps(EXAMPLE_RESPONSE.content)
  }

  return (
    <div style={styles.app}>
      <Canvas
        dpr={[1, 1.5]}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        camera={{ fov: 45, near: 0.001, far: 100000, position: [3, 2, 5] }}
      >
        <color attach="background" args={['#111827']} />
        <ambientLight intensity={0.9} />
        <directionalLight position={[5, 5, 5]} intensity={1.1} />
        <directionalLight position={[-5, 2, -3]} intensity={0.45} />

        <Suspense fallback={null}>
          <Bounds fit margin={1.18}>
            <Center>
              {MODEL_CONFIGS.map((config) => (
                  <StructureModel
                    key={config.key}
                    config={config}
                    opacity={modelOpacities[config.key]}
                    selectedStructure={selectedStructure}
                    hoveredId={hoveredId}
                    hiddenIds={hiddenIds}
                    structureColors={structureColors}
                    selectedIds={selectedIds}
                    showOnlySelected={showOnlySelected}
                    customGroups={customGroups}
                    showOnlyCustomGroupName={showOnlyCustomGroupName}
                    highlightSelected={highlightSelected}
                    onReady={handleModelReady}
                    onSelect={handleStructureClick}
                    onHover={setHoveredId}
                  />
              ))}
            </Center>
          </Bounds>
        </Suspense>

        <OrbitControls
          ref={controlsRef}
          makeDefault
          enabled={!dragSelectMode}
          enableDamping
          dampingFactor={0.08}
          zoomSpeed={0.6}
          rotateSpeed={0.7}
          panSpeed={0.7}
        />
        <CameraFocus request={focusRequest} controlsRef={controlsRef} />
        <CameraRefSync cameraRef={cameraRef} />
      </Canvas>

      <div
        ref={overlayRef}
        onPointerDown={startDragBox}
        onPointerMove={updateDragBox}
        onPointerUp={finishDragBox}
        onPointerCancel={() => setDragBox(null)}
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
        <div style={{ fontSize: 19, fontWeight: 700 }}>Anatomy Explorer</div>
        <div style={{ ...styles.muted, fontSize: 11, margin: '3px 0 14px' }}>
          Bone · Muscle · Joint · Ligament
        </div>

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

        {MODEL_CONFIGS.map((config) => (
          <RangeControl
            key={config.key}
            label={config.label}
            value={modelOpacities[config.key]}
            onChange={(opacity) => setModelOpacity(config.key, opacity)}
          />
        ))}

        <details style={{ ...styles.card, margin: '14px 0' }}>
          <summary style={{ cursor: 'pointer' }}>
            <strong>Hidden structures</strong>
            <div style={{ ...styles.muted, fontSize: 11, marginTop: 2 }}>
              {hiddenStructures.length} structure
              {hiddenStructures.length === 1 ? '' : 's'} hidden
            </div>
          </summary>

          {hiddenStructures.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => setHiddenIds(new Set())}
                style={{ ...styles.button, width: '100%', marginTop: 10 }}
              >
                Unhide all
              </button>

              {hiddenStructures.map((structure) => (
                <div
                  key={structure.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    padding: '8px 0',
                    borderTop: '1px solid rgba(255,255,255,0.12)',
                  }}
                >
                  <span>{structure.displayLabel}</span>

                  <button
                    type="button"
                    onClick={() => toggleStructureHidden(structure)}
                    style={styles.button}
                  >
                    Unhide
                  </button>
                </div>
              ))}
            </>
          )}
        </details>
        <details style={{ ...styles.card, marginBottom: 14 }}>
          <summary style={{ cursor: 'pointer' }}>
            <strong>Colored structures</strong>
            <div style={{ ...styles.muted, fontSize: 11, marginTop: 2 }}>
              {coloredStructures.length} structure
              {coloredStructures.length === 1 ? '' : 's'} recolored
            </div>
          </summary>

          {coloredStructures.map((structure) => (
            <div
              key={structure.id}
              style={{
                padding: '9px 0',
                borderTop: '1px solid rgba(255,255,255,0.12)',
              }}
            >
              <div style={{ marginBottom: 7 }}>
                {structure.displayLabel}
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {COLOR_OPTIONS.map(([label, color]) => (
                  <button
                    key={color}
                    type="button"
                    title={label}
                    onClick={() => setStructureColor(structure, color)}
                    style={{
                      ...styles.button,
                      width: color === 'original' ? 'auto' : 24,
                      height: 24,
                      padding: color === 'original' ? '2px 7px' : 0,
                      background:
                        color === 'original'
                          ? styles.button.background
                          : color,
                    }}
                  >
                    {color === 'original' ? 'Original' : ''}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </details>
        <div style={{ ...styles.card, marginBottom: 14 }}>
          <span>
            <strong>Selected structures</strong>
            <div style={{ ...styles.muted, fontSize: 11, marginTop: 2 }}>
              {selectedIds.size} structure{selectedIds.size === 1 ? '' : 's'} selected
            </div>
          </span>

          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              cursor: 'pointer',
              marginTop: 9,
              marginBottom: 7,
            }}
          >
            <span>Multi-select (click adds to list)</span>
            <input
              type="checkbox"
              checked={multiSelectMode}
              onChange={(event) => setMultiSelectMode(event.target.checked)}
            />
          </label>

          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              cursor: 'pointer',
              marginBottom: 7,
            }}
          >
            <span>Drag-select (draw a box)</span>
            <input
              type="checkbox"
              checked={dragSelectMode}
              onChange={(event) => {
                setDragSelectMode(event.target.checked)
                setDragBox(null)
              }}
            />
          </label>

          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              cursor: 'pointer',
              marginBottom: 7,
            }}
          >
            <span>Show only selected</span>
            <input
              type="checkbox"
              checked={showOnlySelected}
              onChange={(event) => setShowOnlySelected(event.target.checked)}
            />
          </label>

          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              cursor: 'pointer',
              marginBottom: 9,
            }}
          >
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

          <SelectedStructuresPanel
            selectedStructures={selectedStructures}
            expandedId={expandedSelectedId}
            hiddenIds={hiddenIds}
            structureColors={structureColors}
            onToggleExpand={(id) => {
              setExpandedSelectedId((current) => current === id ? null : id)
            }}
            onToggleHidden={toggleStructureHidden}
            onColorChange={setStructureColor}
            onFocus={focusStructure}
            onRemove={(structure) => removeSelectedId(structure.id)}
            customGroups={customGroups}
            onAddToGroup={addStructureToGroup}
          />
        </div>
        <div style={{ ...styles.card, marginBottom: 14 }}>
          <strong>Custom groups</strong>

          <div
            style={{
              display: 'flex',
              gap: 6,
              marginTop: 9,
              marginBottom: 10,
            }}
          >
            <input
              value={newGroupName}
              onChange={(event) => setNewGroupName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') createCustomGroup()
              }}
              placeholder="New group name"
              style={styles.input}
            />

            <button
              type="button"
              onClick={createCustomGroup}
              style={styles.button}
            >
              Add
            </button>
          </div>

          {Object.entries(customGroups).map(([groupName, ids]) => {
            const groupStructures = structures.filter((structure) =>
              ids.has(structure.id)
            )

            return (
              <details key={groupName}>
                <summary style={{ cursor: 'pointer', padding: '7px 0' }}>
                  {groupName} ({groupStructures.length})
                </summary>

                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 5,
                    marginBottom: 8,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => selectCustomGroup(groupName)}
                    style={styles.button}
                  >
                    Select all
                  </button>

                  <button
                    type="button"
                    onClick={() => hideCustomGroup(groupName)}
                    style={styles.button}
                  >
                    Hide
                  </button>

                  <button
                    type="button"
                    onClick={() => showCustomGroup(groupName)}
                    style={styles.button}
                  >
                    Show
                  </button>

                  <button
                    type="button"
                    onClick={() => toggleShowOnlyCustomGroup(groupName)}
                    style={styles.button}
                  >
                    {showOnlyCustomGroupName === groupName ? 'Show all' : 'Show only'}
                  </button>

                  <button
                    type="button"
                    onClick={() => deleteCustomGroup(groupName)}
                    style={styles.button}
                  >
                    Delete
                  </button>
                </div>

                {groupStructures.map((structure) => (
                  <div
                    key={structure.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      padding: '6px 0',
                      borderTop: '1px solid rgba(255,255,255,0.1)',
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedStructure(structure)
                        toggleSelectedId(structure.id)
                      }}
                      style={{
                        border: 0,
                        padding: 0,
                        color: 'white',
                        background: 'transparent',
                        textAlign: 'left',
                        cursor: 'pointer',
                      }}
                    >
                      {structure.displayLabel}
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        removeStructureFromGroup(groupName, structure.id)
                      }
                      style={{ ...styles.button, padding: '3px 7px' }}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </details>
            )
          })}
        </div>
        <StructureDetails
          structure={selectedStructure}
          isHidden={selectedStructure ? hiddenIds.has(selectedStructure.id) : false}
          isSelected={selectedStructure ? selectedIds.has(selectedStructure.id) : false}
          selectedColor={selectedStructure
            ? structureColors[selectedStructure.id] ?? 'original'
            : 'original'}
          onToggleHidden={toggleSelectedHidden}
          onToggleSelected={toggleSelectedInList}
          onColorChange={changeSelectedColor}
          onFocus={focusSelectedStructure}
          onDeselect={() => {
            setSelectedStructure(null)
            setHoveredId(null)
          }}
          customGroups={customGroups}
          onAddToGroup={(groupName) =>
            addStructureToGroup(groupName, selectedStructure.id)
          }
        />
      </aside>
    </div>
  )
}

MODEL_CONFIGS.forEach((config) => useGLTF.preload(config.url))

export default App