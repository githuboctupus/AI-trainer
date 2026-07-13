import { Canvas } from '@react-three/fiber'
import { OrbitControls, useGLTF, Bounds, Center } from '@react-three/drei'
import { Suspense, useState, useRef, useEffect } from 'react'
import * as THREE from 'three'

function Model({ url, opacity }) {
  const { scene } = useGLTF(url)
  const cloned = useRef()

  if (!cloned.current) {
    cloned.current = scene.clone(true)

    // Normalize to a consistent size regardless of source file's units
    const box = new THREE.Box3().setFromObject(cloned.current)
    const size = box.getSize(new THREE.Vector3())
    const maxDim = Math.max(size.x, size.y, size.z)
    const targetSize = 2 // world units you want the model's largest dimension to be
    cloned.current.scale.multiplyScalar(targetSize / maxDim)

    cloned.current.traverse((child) => {
      if (child.isMesh) {
        child.material = child.material.clone()
        child.material.transparent = true
      }
    })
  }
  useEffect(() => {
    cloned.current.traverse((child) => {
      if (child.isMesh) {
        child.material.opacity = opacity
        child.material.depthWrite = opacity > 0.95 // avoids sorting artifacts when fully opaque
      }
    })
  }, [opacity])

  return <primitive object={cloned.current} />
}

function App() {
  const [skeletonOpacity, setSkeletonOpacity] = useState(1)
  const [anatomyOpacity, setAnatomyOpacity] = useState(0.6)

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative' }}>
      <Canvas camera={{ fov: 50 }}>
        <ambientLight intensity={0.8} />
        <directionalLight position={[5, 5, 5]} intensity={1} />
        <Suspense fallback={null}>
          <Bounds fit clip margin={1.2}>
            <Center>
              <group rotation={[-Math.PI / 2, 0, 0]}>
                <Model url="/skeleton.glb" opacity={skeletonOpacity} />
                <Model url="/anatomy.glb" opacity={anatomyOpacity} />
              </group>
            </Center>
          </Bounds>
        </Suspense>
        <OrbitControls makeDefault />
      </Canvas>

      <div style={{
        position: 'absolute', top: 20, left: 20,
        background: 'rgba(0,0,0,0.6)', padding: '12px 16px',
        borderRadius: 8, color: 'white', fontFamily: 'sans-serif', fontSize: 14
      }}>
        <div style={{ marginBottom: 10 }}>
          <label>Skeleton opacity: {skeletonOpacity.toFixed(2)}</label><br />
          <input type="range" min="0" max="1" step="0.01"
            value={skeletonOpacity}
            onChange={(e) => setSkeletonOpacity(parseFloat(e.target.value))}
          />
        </div>
        <div>
          <label>Muscles opacity: {anatomyOpacity.toFixed(2)}</label><br />
          <input type="range" min="0" max="1" step="0.01"
            value={anatomyOpacity}
            onChange={(e) => setAnatomyOpacity(parseFloat(e.target.value))}
          />
        </div>
      </div>
    </div>
  )
}

export default App