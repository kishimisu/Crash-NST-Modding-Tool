import { AmbientLight, DirectionalLight, MeshBasicMaterial, MeshPhongMaterial, PerspectiveCamera, Scene, WebGLRenderer, Vector3, Raycaster, Vector2, Euler, Mesh, SphereGeometry, DoubleSide, FogExp2, BufferGeometry, Float32BufferAttribute, Group, Color } from 'three'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls'
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { elm, getArchiveFolder } from './utils/utils'
import IGZ from '../../igz/igz'
import ObjectView from './object_view'
import igObject from '../../igz/igObject'
import { ipcRenderer } from 'electron'
import { extractModelData } from './utils/model_extract';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';

class LevelExplorer {
    constructor() {
        this.visible = false
        this.initialized = false
        this.mode = 'level' // level, model

        elm('#focus-in-explorer').addEventListener('click', () => {
            const object = Main.objectView.object
            
            if (!this.initialized) this.init()
            else this.toggleVisibility(true)

            const match = this.scene.children.find(e => e.userData?.igz == Main.igz.path && e.userData?.objectIndex == object.index)

            if (match) {
                this.cam.position.set(match.position.x, match.position.y + 100, match.position.z - 200)
                this.cam.lookAt(match.position)
                this.transformControls.attach(match)
                this.renderer.render(this.scene, this.cam)
            }
        })
    }

    toggleVisibility(visible) {
        elm('#explorer').style.display = visible ? 'block' : 'none'
        elm('#data-view').style.height = visible ? '10px' : ''
        this.visible = visible
    }

    toggleShowSplines(checked) {
        localStorage.setItem('explorer-show-splines', checked)
        if (this.initialized) this.init()
    }

    toggleShowEntityLinks(checked) {
        localStorage.setItem('explorer-show-entity-links', checked)
        if (this.initialized) this.init()
    }

    toggleShowGrass(checked) {
        localStorage.setItem('explorer-show-grass', checked)
        if (this.initialized) this.init()
    }

    toggleShowAllObjects(checked) {
        localStorage.setItem('explorer-show-all-objects', checked)
        if (this.initialized) this.init()
    }

    toggleFullResolution(checked) {
        localStorage.setItem('explorer-full-resolution', checked)
        if (this.onResize) this.onResize()
    }

    deselectObject() {
        if (this.mode == 'model') return
        this.transformControls?.detach()
        this.renderer?.render(this.scene, this.cam)
    }

    showModel(igz) {
        const model = extractModelData(igz)
        if (model == null) return console.warn('No model data found in', igz.path)

        if (!this.renderer) this.initRenderer()
        this.mode = 'model'

        const scene = new Scene()
        const cam = new PerspectiveCamera(75, this.canvas.width / this.canvas.height, 1, 40000)

        const ambientLight = new AmbientLight(0x525255)
        scene.add(ambientLight)

        const d1 = new DirectionalLight(0xffffff, 1)
        d1.position.set(.1, 1.1, .34)
        scene.add(d1)

        const d2 = new DirectionalLight(0xfaf8ff, 0.5)
        d2.position.set(-.15, -.9, -.4)
        scene.add(d2)

        if (this.model_controls) this.model_controls.dispose()
        this.model_controls = new OrbitControls(cam, this.renderer.domElement)
        this.model_controls.addEventListener('change', () => this.renderer.render(scene, cam))

        const { drawCalls } = model
        let boundsMin = [Infinity, Infinity, Infinity]
        let boundsMax = [-Infinity, -Infinity, -Infinity]

        const group = new Group()
        for (let j = 0; j < drawCalls.length; j++) {
            const drawCall = drawCalls[j]
            const mesh = this.createMesh(drawCall)
            boundsMin = drawCall.vertexData.reduce((acc, e) => acc.map((v, i) => Math.min(v, e.position[i])), boundsMin)
            boundsMax = drawCall.vertexData.reduce((acc, e) => acc.map((v, i) => Math.max(v, e.position[i])), boundsMax)
            group.add(mesh)
        }
        scene.add(group)

        const center = [(boundsMin[0] + boundsMax[0]) / 2, (boundsMin[1] + boundsMax[1]) / 2, (boundsMin[2] + boundsMax[2]) / 2]
        this.model_controls.target.set(center[0], center[1], center[2])
        cam.position.set(center[0] - Math.max(boundsMax[0] - boundsMin[0], boundsMax[2] - boundsMin[2]), center[1] + 60, center[2])

        this.model_scene = scene
        this.model_cam = cam

        this.toggleVisibility(true)
        requestAnimationFrame(() => {
            this.model_controls.update()
            this.renderer.render(scene, cam)
        })
    }

    getScene() {
        return this.model_scene ?? this.scene
    }

    getCamera() {
        return this.model_cam ?? this.cam
    }

    initRenderer() {
        const getPixelRatio = () => (localStorage.getItem('explorer-full-resolution') ?? 'false') === 'true' ? window.devicePixelRatio : Math.min(1, window.devicePixelRatio) 
        const canvas = elm('canvas')
        this.renderer = new WebGLRenderer({ canvas })
        this.renderer.setClearColor(0x2661ab)
        this.canvas = canvas

        elm('#hide-explorer').addEventListener('click', () => this.toggleVisibility(false))

        this.onResize = () => {
            const bounds = canvas.getBoundingClientRect()
            canvas.width = bounds.width * getPixelRatio()
            canvas.height = bounds.height * getPixelRatio()
            this.renderer.setViewport(0, 0, canvas.width, canvas.height)
            this.getCamera().updateProjectionMatrix()
            this.renderer.render(this.getScene(), this.getCamera())
        }
        window.addEventListener('resize', () => this.onResize())
        requestAnimationFrame(() => this.onResize())
    }

    init() {
        if (!this.initialized) {
            if (!this.renderer) this.initRenderer()
            this.scene = new Scene()
            this.cam = new PerspectiveCamera(75, canvas.width / canvas.height, 1, 40000)

            this.transformControls = new TransformControls(this.cam, this.renderer.domElement)
            this.transformControls.setMode('translate')

            let timeout = null
            this.transformControls.addEventListener('objectChange', () => {
                clearTimeout(timeout)
                timeout = setTimeout(() => {
                    const object = this.transformControls.object
                    if (object) {
                        Main.objectView.onFieldUpdate(Main.objectView.fields[2], (-object.position.x).toFixed(3), 0)
                        Main.objectView.onFieldUpdate(Main.objectView.fields[2], object.position.z.toFixed(3), 1)
                        Main.objectView.onFieldUpdate(Main.objectView.fields[2], object.position.y.toFixed(3), 2)
                    }
                }, 500)
            })
            
            this.controls = new NoClipControls(this)
            
            this.loader = new FBXLoader()
            this.raycaster = new Raycaster()

            let lastObject = null
            let lastColor  = null

            window.editor = this

            let dragging = false
            canvas.addEventListener('mousedown', () => dragging = false)
            canvas.addEventListener('mousemove', () => dragging = true)
            
            canvas.addEventListener('mouseup', async (event) => {
                if (dragging) return
                const boundingRect = canvas.getBoundingClientRect()
                const x = (event.clientX - boundingRect.left) / boundingRect.width * 2 - 1
                const y = -((event.clientY - boundingRect.top) / boundingRect.height) * 2 + 1
                const mouse = new Vector2(x, y)

                this.raycaster.setFromCamera(mouse, this.cam)
                const intersects = this.raycaster.intersectObjects(this.scene.children)

                if (intersects.length > 0) {
                    const object =  intersects.map(e => e.object).find(e => e.userData.igz != null)
                                 ?? intersects.map(e => e.object.parent).find(e => e.userData.igz != null)

                    lastObject?.children?.forEach(e => e.material.color.set(lastColor))

                    if (object != null) {
                        lastObject = object
                        lastColor = object.children?.length > 0 ? object.children[0].material.color.clone() : object.material.color.clone()

                        object.children?.forEach(e => e.material.color.set(0xeda93b))

                        const objectData = object.userData
                        
                        if (!Main.igz || Main.treeMode == 'pak' || Main.igz.path != objectData.igz) {
                            const confirm = !Main.igz?.updated || await ipcRenderer.invoke('show-confirm-message', 'You have unsaved changes. Do you want to continue?')
                            if (!confirm) return
                            const fileIndex = Main.pak.files.findIndex(e => e.path == objectData.igz)
                            const fileInfos = Main.pak.files[fileIndex]
                            Main.setIGZ(IGZ.fromFileInfos(fileInfos))
                            Main.igz.setupEXID(getArchiveFolder(), Main.pak)
                            Main.showIGZTree()
                            Main.lastFileIndex = fileIndex
                        }

                        console.log(objectData)

                        this.transformControls.attach(object)

                        const node = Main.tree.available().find(e => e.type == 'object' && e.objectIndex == objectData.objectIndex)
                        if (node) {
                            node.expandParents()
                            node.select()
                            node.focus()
                        }
                        const igObject = Main.igz.objects[objectData.objectIndex]
                        Main.objectView = new ObjectView(igObject)
                    }
                    else {
                        this.transformControls.detach()
                    }
                }
            })

            const fog = new FogExp2(0x2661ab, 0.00006)
            this.scene.fog = fog

            this.initialized = true
            this.render()
        }

        this.pak = Main.pak
        this.scene.clear()
        this.toggleVisibility(true)

        if (this.mode == 'model') {
            this.mode = 'level'
            this.model_scene = null
            this.model_cam = null
            this.model_controls.dispose()
            this.model_controls = null
        }

        // Add ambient light
        const ambientLight = new AmbientLight(0x525255)
        this.scene.add(ambientLight)

        // Add directional light
        const d1 = new DirectionalLight(0xf0f0ff, 1.1)
        d1.position.set(.1, 1, -.4)
        this.scene.add(d1)

        const d2 = new DirectionalLight(0xfaf8ff, 0.2)
        d2.position.set(-.2, -.9, .3)
        this.scene.add(d2)

        this.scene.add(this.transformControls)

        this.cam.position.set(-40, 600, -1000)
        this.cam.rotation.set(0, Math.PI, 0)

        const modelFiles = []
        const mapFiles   = []

        const showGrass = (localStorage.getItem('explorer-show-grass') ?? 'false') === 'true'

        for (const file of Main.pak.files) {
            if (!file.path.endsWith('.igz')) continue

            if (file.path.startsWith('actors/') || file.path.startsWith('models/') && !file.path.includes('Designer_Level_Template')) {
                if (showGrass || !file.path.includes('Grass'))
                modelFiles.push(file)
            }
            else if (file.path.startsWith('maps/') && !file.path.includes('Audio') && !file.path.includes('Music') && !file.path.includes('StaticCollision'))
                mapFiles.push(file)
        }

        const models = {}
        const show_all_objects = (localStorage.getItem('explorer-show-all-objects') ?? 'false') === 'true'
        const hidden_objects = ['cloud', 'shadow', 'palmcluster']
        
        // Create model meshes
        for (let i = 0; i < modelFiles.length; i++) {
            const file = modelFiles[i]
            const name = file.path.split('/').pop()

            const title = 'Constructing models'
            ipcRenderer.send('set-progress-bar', i, modelFiles.length, title, `Reading file ${name}`, 'models loaded')

            const igz = IGZ.fromFileInfos(file)
            const modelData = extractModelData(igz)
            if (modelData == null) continue
            const { drawCalls } = modelData

            const group = new Group()
            for (let j = 0; j < drawCalls.length; j++) {
                const drawCall = drawCalls[j]
                const mesh = this.createMesh(drawCall)
                group.add(mesh)
            }
            models[name.replace('.igz', '')] = group
        }
        
        const processObjects = (igz, type, callback) => {
            const objects = igz.objects.filter(e => e.type == type && e.references.length <= 1)
            const validObjects = []

            for (const object of objects) {
                const lowername = object.name.toLowerCase()
                if (!showGrass && lowername.includes('grass')) continue
                if (!show_all_objects && hidden_objects.some(e => lowername.includes(e))) continue
                const result = callback(igz, object)
                if (result) validObjects.push(result)
            }
            return validObjects
        }

        const loaded = {
            igEntities: [],
            CEntities: [],
            CGameEntities: [],
            CPhysicalEntities: [],
            CPlayerStartEntities: []
        }

        const processNextFile = (index = 0) => {
            this.renderer.render(this.scene, this.cam)

            const file = mapFiles[index]
            const title = 'Loading level files...'
            ipcRenderer.send('set-progress-bar', index, mapFiles.length, title, `Reading ${file.path.split('/').pop()}`, 'files processed')

            const igz = IGZ.fromFileInfos(file)
            
            const igEntities        = processObjects(igz, 'igEntity', this.process_igEntity)
            const CEntities         = processObjects(igz, 'CEntity', this.process_CEntity)
            const CGameEntities     = processObjects(igz, 'CGameEntity', this.process_CGameEntity)
            const CPhysicalEntities = processObjects(igz, 'CPhysicalEntity', this.process_CPhysicalEntity)
            const CPlayerStartEntity = processObjects(igz, 'CPlayerStartEntity', this.process_CPlayerStartEntity)
            const entities = igEntities.concat(CEntities).concat(CGameEntities).concat(CPhysicalEntities).concat(CPlayerStartEntity)

            loaded.igEntities.push(...igEntities)
            loaded.CEntities.push(...CEntities)
            loaded.CGameEntities.push(...CGameEntities)
            loaded.CPhysicalEntities.push(...CPhysicalEntities)
            loaded.CPlayerStartEntities.push(...CPlayerStartEntity)

            for (const entity of entities) {
                if (entity == null) continue

                if (entity.name.includes('Collectible_Wumpa'))
                    entity.model_name = "crash_wumpafruit_no_sparkles"
                else if (entity.name.includes('Collectible_ExtraLife'))
                    entity.model_name = "Collectible_Crash_ExtraLife"

                if (entity.model_name == null) {
                    this.loadModel(null, entity)
                    continue
                }

                const model_name = entity.model_name.split('\\').pop().replace('.igb', '')
                const model = models[model_name]

                if (model == null) console.warn(`Could not find model ${model_name}`)

                this.loadModel(model?.clone(), entity)
            }

            if (index < mapFiles.length - 1) 
                processNextFile(index + 1)
            else {
                ipcRenderer.send('set-progress-bar', null)
                const position = loaded.CPlayerStartEntities.find(e => e.name.toLowerCase().includes('playerstartall'))?.position
                if (position != null)
                    this.cam.position.set(position[0], position[1] + 200, position[2] - 300)
                this.renderer.render(this.scene, this.cam)
                console.log('Loaded', loaded)
            }
        }

        processNextFile()
    }

    process_igEntity(igz, object) 
    {
        const igEntityData         = object.getChild('igEntityData')
        const igComponentDataTable = igEntityData.getChild('igComponentDataTable')
        const CModelComponentData  = igComponentDataTable.tryGetChild('CModelComponentData')
        
        if (!CModelComponentData) return object.toMeshInfo(igz)

        const model_name = CModelComponentData.getModel(igz)

        const igEntityTransform = object.tryGetChild('igEntityTransform')
        const transform = igEntityTransform?.getTransform()

        return object.toMeshInfo(igz, { model_name, transform })
    }

    process_CEntity(igz, object) 
    {
        if (object.name.endsWith('_gen')) return null

        const CEntityData          = object.getChild('CEntityData')
        const igComponentDataTable = CEntityData.getChild('igComponentDataTable')
        const CVscComponentData    = igComponentDataTable.tryGetChild('CVscComponentData', 'CommonSpawnerTemplate')
        const color = 0x77ff6b

        if (!CVscComponentData) return object.toMeshInfo(igz, {color}) 

        const EntityToSpawn = CVscComponentData.view.readUInt(0x48)

        if ((EntityToSpawn & 0x80000000) == 0) {
            console.warn('[CEntity] NOT A HANDLE', object.name, EntityToSpawn)
            return object.toMeshInfo(igz, {color})
        }

        const spawnerName = igz.named_handles[EntityToSpawn & 0x7FFFFFFF][0]
        const Entity = igz.objects.find(e => e.name == spawnerName)

        if (!Entity) return console.warn('[CEntity] No object found for', object.name)
        if (!['CPhysicalEntity', 'CGameEntity', 'CActor'].includes(Entity.type)) return object.toMeshInfo(igz, {color})

        const EntityData = Entity.getChild(Entity.type + 'Data')
        const model_name = EntityData.getModel(igz)

        const igEntityTransform = object.tryGetChild('igEntityTransform')
        const igParentTransform = Entity.tryGetChild('igEntityTransform')
        const transform = igParentTransform?.getTransform() ?? igEntityTransform?.getTransform() ?? {}
        const parentPosition = Entity.view.readVector(3, 0x20)

        return object.toMeshInfo(igz, { model_name, transform, color, parentPosition})
    }

    process_CGameEntity(igz, object) 
    {
        const CGameEntityData = object.getChild('CGameEntityData')
        const model_name = CGameEntityData.getModel(igz)
        const color = 0x63edff

        const show_splines = (localStorage.getItem('explorer-show-splines') ?? 'true') === 'true'
        let controlPoints = null
        if (show_splines) {
            const igSplineControlPoint2List = CGameEntityData.tryGetChildRecursive('igComponentDataTable', 'CSplineComponentData', 'igSpline2', 'igSplineControlPoint2List')
            controlPoints = igSplineControlPoint2List?.children.map(e => e.object.toMeshInfo(igz, {position: e.object.view.readVector(3, 0x10)}))
        }

        const igEntityTransform = object.tryGetChild('igEntityTransform')
        const transform = igEntityTransform?.getTransform()

        return object.toMeshInfo(igz, { model_name, transform, color, controlPoints })
    }

    process_CPhysicalEntity(igz, object) 
    {
        const CPhysicalEntityData = object.getChild('CPhysicalEntityData')
        const model_name = CPhysicalEntityData.getModel(igz)
        const color = 0xee222e

        const igEntityTransform = object.tryGetChild('igEntityTransform')
        const transform = igEntityTransform?.getTransform()

        return object.toMeshInfo(igz, { model_name, transform, color })
    }

    process_CPlayerStartEntity(igz, object)
    {
        return object.toMeshInfo(igz, {color: 0xff00ff})
    }

    createMesh(drawCall) {
        const geometry = new BufferGeometry()
        const material = new MeshPhongMaterial({ color: 0xffffff, shininess: 150, side: DoubleSide, wireframe: false })
    
        const vertices = drawCall.vertexData.map(e => e.position).flat()
        const normals  = drawCall.vertexData.map(e => e.normal).flat()
        const indices  = drawCall.indexData
    
        geometry.setAttribute('position', new Float32BufferAttribute(vertices, 3))
        geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3))
        geometry.setIndex(indices)
    
        const mesh = new Mesh(geometry, material)
        return mesh
    }

    loadModel(model, entity) {
        let { name, position, rotation, scale, color, parentPosition, controlPoints } = entity

        if (model == null) {
            const geo = new SphereGeometry(20, 20, 20)
            const mat = new MeshBasicMaterial()
            model = new Mesh(geo, mat)
        }
        model.userData = { ...entity }

        // Apply custom color (temporary)
        const lower = name.toLowerCase()
        if (name.includes('Crate_')) {
            color = 0xfaba52
        }
        else if (name.includes('Collectible_Wumpa')) {
            color = 0xffdd12
        }
        else if (lower.includes('water')) {
            color = 0x1278ff
        }
        else if (lower.includes('terrain') || lower.includes('riverbank') || name.startsWith('Path')) {
            color = 0xffe180
        }

        // Create splines (camera...)
        if (controlPoints) {
            controlPoints.forEach(e => e.position = e.position.map((v, i) => v + position[i]))
            this.createLine(controlPoints, 0xff0000, 0.001, true)
        }

        if (position[0] == 0 && position[1] == 0 && position[2] == 0) {
            if (name.endsWith('_gen')) return
            console.log('No position for', name)
        }

        // Link CEntity to spawners
        const show_entity_links = (localStorage.getItem('explorer-show-entity-links') ?? 'false') === 'true'
        if (show_entity_links && parentPosition && !(parentPosition[0] == 0 && parentPosition[1] == 0 && parentPosition[2] == 0)) {
            this.createLine([{position}, {position: parentPosition}], color, 0.005, false)
        }

        // Apply material
        model.traverse((child) => {
            if (child.isMesh) {
                child.material = child.material.clone()
                child.material.color.set(color ?? 0xffffff)
            }
        })

        // Set position
        model.position.set(...position)

        // Set rotation
        if (rotation) {
            model.rotateY(rotation[1])
            model.rotateZ(rotation[2])
            model.rotateX(rotation[0])
        }
        //model.rotateY(-Math.PI/2)

        // Set scale
        if (scale)
            model.scale.set(...scale)

        // Add object to scene
        this.scene.add(model)
    }

    createLine(points, color, width, addMarkers = true) {
        const geo = new LineGeometry()
        geo.setPositions(points.map(e => e.position).flat())
        const mat = new LineMaterial({
            color: color,
            linewidth: width,
        })
        const line = new Line2(geo, mat)
        line.computeLineDistances()
        line.scale.set(1, 1, 1)
        this.scene.add(line)

        if (addMarkers) {
            for (const point of points) {
                const dot = new SphereGeometry(5, 5, 5)
                const sphere = new Mesh(dot, new MeshBasicMaterial({ color: 0xff0000 }))
                sphere.position.set(...point.position)
                sphere.userData = { ...point }
                this.scene.add(sphere)
            }
        }
    }

    render() {
        requestAnimationFrame(() => this.render())
        if (this.mode == 'model') return
        
        if (this.controls.update())
            this.renderer.render(this.scene, this.cam)
    }
}

class NoClipControls {
    constructor(explorer) {
        this.camera = explorer.cam
        this.canvas = explorer.canvas
        this.explorer = explorer

        this.clicked = false
        this.moveForward = false
        this.moveBackward = false
        this.moveLeft = false
        this.moveRight = false
        this.shift = false
        this.space = false
        this.speedBoost = false

        this.velocity = new Vector3()
        this.direction = new Vector3()
        this.moveSpeed = 100.0
        this.lookSpeed = 5.0

        this.euler = new Euler( 0, 0, 0, 'YXZ' )
        this.minPolarAngle = 0
        this.maxPolarAngle = Math.PI

        this.lastTime = performance.now()

        this.canvas.addEventListener('mousemove', (e) => this.onMouseMove(e), false)
        this.canvas.addEventListener('mousedown', (e) => this.onMouseClick(e, true), false)
        this.canvas.addEventListener('mouseup', (e) => this.onMouseClick(e, false), false)
        document.addEventListener('keydown', (e) => this.onKeyDown(e), false)
        document.addEventListener('keyup', (e) => this.onKeyUp(e), false)
    }

    onKeyDown(event) {   
        switch (event.code) {
            case 'KeyW': this.moveForward = true; break
            case 'KeyA': this.moveLeft = true; break
            case 'KeyS': this.moveBackward = true; break
            case 'KeyD': this.moveRight = true; break     
            case 'ShiftLeft': this.shift = true; break
            case 'Space': this.space = true; break
        }
        this.needsUpdate = true

        if (event.code == 'KeyW' && this.lastKey?.code == 'KeyW' && Date.now() - this.lastKey.time < 80) {
            this.speedBoost = true
        }
    }

    onKeyUp(event) {
        switch (event.code) {
            case 'KeyW': this.moveForward = false; break
            case 'KeyA': this.moveLeft = false; break
            case 'KeyS': this.moveBackward = false; break
            case 'KeyD': this.moveRight = false; break 
            case 'ShiftLeft': this.shift = false; break
            case 'Space': this.space = false; break
        }
        this.needsUpdate = true
        if (event.code == 'KeyW') this.speedBoost = false
        this.lastKey = {
            code: event.code,
            time: Date.now()
        }  
    }

    onMouseClick(event, clicked) {
        this.clicked = clicked
        this.needsUpdate = true

        if (clicked) {
            // Prevent moving the camera if the object transform controller is selected
            const boundingRect = canvas.getBoundingClientRect()
            const x = (event.clientX - boundingRect.left) / boundingRect.width * 2 - 1
            const y = -((event.clientY - boundingRect.top) / boundingRect.height) * 2 + 1
            const mouse = new Vector2(x, y)

            this.explorer.raycaster.setFromCamera(mouse, this.explorer.cam)
            const intersects = this.explorer.raycaster.intersectObjects(this.explorer.scene.children)
            
            if (this.explorer.transformControls.object != null && intersects.length > 0 && intersects.some(e => e.object.parent?.parent?.type == "TransformControlsGizmo")) {
                this.clicked = false
                this.transform = true
            }
        }
        else {
            this.transform = false
        }
    }

    onMouseMove(event) {
        if (!this.clicked) return

        const { movementX, movementY } = event

        this.euler.setFromQuaternion(this.camera.quaternion)
        this.euler.y -= movementX * 0.002 * this.lookSpeed
        this.euler.x -= movementY * 0.002 * this.lookSpeed
        this.euler.x = Math.max(Math.PI/2 - this.maxPolarAngle, Math.min(Math.PI/2 - this.minPolarAngle, this.euler.x))
    
        this.camera.quaternion.setFromEuler(this.euler)
        this.needsUpdate = true
    }

    update() {
        if (this.transform) return true
        if (!this.needsUpdate) return false

        const time = performance.now()
        const delta = Math.min((time - this.lastTime) / 1000, 0.1)
        this.lastTime = time

        const front = new Vector3()
        this.camera.getWorldDirection(front)
        const left = front.clone().cross(this.camera.up)
        const moveSpeed = this.speedBoost ? this.moveSpeed * 5 : this.moveSpeed

        if (!this.clicked) this.moveBackward = this.moveForward = this.moveLeft = this.moveRight = this.space = this.shift = false
        if (this.moveForward) this.velocity.addScaledVector(front, moveSpeed * delta)
        if (this.moveBackward) this.velocity.addScaledVector(front, -moveSpeed * delta)
        if (this.moveLeft) this.velocity.addScaledVector(left, -moveSpeed * delta)
        if (this.moveRight) this.velocity.addScaledVector(left, moveSpeed * delta)
        if (this.space) this.velocity.y += moveSpeed * delta
        if (this.shift) this.velocity.y -= moveSpeed * delta

        this.camera.position.add(this.velocity)
        this.velocity.multiplyScalar(0.9)

        this.needsUpdate = this.velocity.lengthSq() > 0.0001

        return true
    }
}

igObject.prototype.tryGetChild = function(type, name) {
    return name == null
        ? this.children.find(e => e.object.type == type)?.object
        : this.children.find(e => e.object.type == type && e.object.name.includes(name))?.object
}

igObject.prototype.getChild = function(type, name) {
    const child = this.tryGetChild(type, name)
    if (child == null) throw new Error(`No child ${name??' '}of type ${type} found in ${this.getName()}`)
    return child
}

igObject.prototype.tryGetChildRecursive = function(...types) {
    let object = this
    for (const type of types) {
        object = object.tryGetChild(type)
        if (object == null) return null
    }
    return object
}

igObject.prototype.tryGetChildren = function(type) {
    return this.children.filter(e => e.object.type == type).map(e => e.object)
}

igObject.prototype.getChildren = function(type) {
    const children = this.children.filter(e => e.object.type == type).map(e => e.object)
    if (children.length == 0) throw new Error(`Could not find ${type} in object ${this.getName()}`)
    return children
}

igObject.prototype.getTransform = function() {
    const quaternion = this.view.readVector(4, 0x10)
    const matrix = this.view.readVector(16, 0x20)
    if (quaternion.concat(matrix).some((e, i) => [0,0,0,1,1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1][i] != e)) throw new Error('Quaternion or Matrix has a value')
    const rotation = this.view.readVector(3, 0x60)
    const scale = this.view.readVector(3, 0x70)

    return { rotation, scale }
}

igObject.prototype.getModel = function(igz) {
    let model_offset = this.type == 'CActorData' ? 0x98 : this.type == 'CModelComponentData' ? 0x18 : 0x48
    
    const hasModel = igz.fixups.RSTT?.data.includes(this.offset + model_offset)
    const hasSkin  = igz.fixups.RSTT?.data.includes(this.offset + model_offset + 8)

    
    if (hasSkin) {
        const index = this.view.readUInt(model_offset + 8)
        const skin = igz.fixups.TSTR?.data[index]
        if (skin == null) throw new Error(`Skin not found at index ${index} in ${this.getName()}`)
        if (skin != '') return skin
    }
    if (hasModel) {
        const index = this.view.readUInt(model_offset)
        const model = igz.fixups.TSTR?.data[index]
        if (model == null) throw new Error(`Model not found at index ${index} in ${this.getName()}`)
        if (model != '') return model
    }

    // const name = this.name.toLowerCase()
    // if (this.type != 'CGameEntityData' && !name.includes('collectible_wumpa') && !name.includes('collectible_extralife')) 
    //     console.log(`No model or skin found in ${this.getName()}`)
    
    return null
}

igObject.prototype.toMeshInfo = function(igz, { color = 0xffffff, transform = {}, ...props } = {}) {
    const convertVector = (v) => [-v[0], v[2], v[1]]
    
    const info = {
        igz: igz.path,
        name: this.name,
        objectIndex: this.index,
        position: this.view.readVector(3, 0x20),
        type: this.type,
        color,
        ...transform,
        ...props
    }

    info.position = convertVector(info.position)
    if (info.scale) info.scale = [info.scale[0], info.scale[2], info.scale[1]]
    if (info.rotation) info.rotation = info.rotation = convertVector(info.rotation)
    if (info.parentPosition) info.parentPosition = convertVector(info.parentPosition)

    return info
}

export default LevelExplorer