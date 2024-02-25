import { AmbientLight, DirectionalLight, MeshBasicMaterial, MeshPhongMaterial, PerspectiveCamera, Scene, WebGLRenderer, Vector3, Raycaster, Vector2, Euler, BoxGeometry, Mesh, SphereGeometry, DoubleSide, FogExp2 } from 'three'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls'
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { elm, getArchiveFolder, getGameFolder, getModelFolder } from './utils/utils'
import { existsSync, readFileSync, rmSync } from 'fs'
import IGZ from '../../igz/igz'
import ObjectView from './object_view'
import igObject from '../../igz/igObject'
import { execSync } from 'child_process';
import { ipcRenderer } from 'electron'

class LevelExplorer {
    static initialized = false

    constructor() {
        this.visible = false

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

    toggleLoadModels(checked) {
        localStorage.setItem('explorer-load-models', checked)
        if (this.initialized) this.init()
    }

    toggleShowSplines(checked) {
        localStorage.setItem('explorer-show-splines', checked)
        if (this.initialized) this.init()
    }

    toggleShowEntityLinks(checked) {
        localStorage.setItem('explorer-show-entity-links', checked)
        if (this.initialized) this.init()
    }

    toggleShowAllObjects(checked) {
        localStorage.setItem('explorer-show-all-objects', checked)
        if (this.initialized) this.init()
    }

    deselectObject() {
        this.transformControls?.detach()
        this.renderer?.render(this.scene, this.cam)
    }

    init() {
        if (!this.initialized) {
            const canvas = elm('canvas')
            this.renderer = new WebGLRenderer({ canvas })
            this.renderer.setPixelRatio(1) // No need for high-res
            this.canvas = canvas

            elm('#hide-explorer').addEventListener('click', () => this.toggleVisibility(false))

            this.scene = new Scene()

            this.cam = new PerspectiveCamera(75, canvas.width / canvas.height, 1, 40000)

            const resizeCanvas = () => {
                const bounds = canvas.getBoundingClientRect()
                canvas.width = bounds.width
                canvas.height = bounds.height
                this.renderer.setViewport(0, 0, bounds.width, bounds.height)
                this.cam.updateProjectionMatrix()
                this.renderer.render(this.scene, this.cam)
            }
            window.addEventListener('resize', () => resizeCanvas())
            requestAnimationFrame(() => resizeCanvas())

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

            this.renderer.setClearColor(0x2661ab)
            
            this.loader = new FBXLoader()
            this.raycaster = new Raycaster()

            let lastObject = null
            let lastColor  = null

            window.editor = this

            let dragging = false
            canvas.addEventListener('mousedown', () => dragging = false)
            canvas.addEventListener('mousemove', () => dragging = true)
            
            canvas.addEventListener('mouseup', (event) => {
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

                    if (lastObject) lastObject.children?.forEach(e => e.material.color.set(lastColor))

                    if (object != null) {
                        object.children?.forEach(e => e.material.color.set(0xeda93b))

                        lastObject = object
                        lastColor = object.children?.length > 0 ? object.children[0].material.color : object.material.color

                        const objectData = object.userData
                        
                        if (!Main.igz || Main.igz.path != objectData.igz) {
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

            this.defaultMaterial = new MeshPhongMaterial({ color: 0xffffff, shininess: 0, side: DoubleSide })

            const fog = new FogExp2(0x2661ab, 0.00006)
            this.scene.fog = fog

            this.initialized = true
            this.render()
        }

        this.pak = Main.pak
        this.scene.clear()
        this.toggleVisibility(true)


        // Add ambient light
        const ambientLight = new AmbientLight(0x525255)
        this.scene.add(ambientLight)

        // Add directional light
        const directionalLight = new DirectionalLight(0xffffff, 1)
        directionalLight.position.set(50, 50, -100)
        this.scene.add(directionalLight)

        this.scene.add(this.transformControls)

        this.cam.position.set(-40, 600, -1000)
        this.cam.rotation.set(0, Math.PI, 0)

        const actorFiles = []
        const modelFiles = []
        const mapFiles   = []

        for (const file of Main.pak.files) {
            if (!file.path.endsWith('.igz')) continue

            if (file.path.startsWith('actors/')) 
                actorFiles.push(file)
            else if (file.path.startsWith('models/') && !file.path.includes('Designer_Level'))
                modelFiles.push(file)
            else if (file.path.startsWith('maps/') && !file.path.includes('Audio') && !file.path.includes('Music') && !file.path.includes('StaticCollision'))
                mapFiles.push(file)
        }

        const exePath = localStorage.getItem("model-extractor-path") ?? getGameFolder("IgzModelConverterGUI.v1.4.exe")
        const show_models = (localStorage.getItem('explorer-load-models') ?? 'true') === 'true'
        const has_converter = existsSync(exePath)
        
        if (show_models && !has_converter) ipcRenderer.send('show-warning-message', 'IgzModelConverterGUI.exe not found. You can set it in Level Explorer->Set model extractor path. See the readme for a download link.\nYou can also disable the option to load models to avoid this warning.')
        this.hasModels = show_models && has_converter

        let models = []

        if (this.hasModels) {
            const allModelFiles = modelFiles.concat(actorFiles)

            // Extract models
            for (let i = 0; i < allModelFiles.length; i++) {
                const file = allModelFiles[i]
                const isActor = file.path.startsWith('actors/')
                const name = file.path.split('/').pop()
                const fbxPath = getModelFolder(name.replace('.igz', '.fbx'))

                if (existsSync(fbxPath)) continue

                const title = 'Extracting models'
                ipcRenderer.send('set-progress-bar', i, allModelFiles.length, title, `Extracting ${name}`, 'models extracted')

                const extractPath = getModelFolder(name)
                const igz = IGZ.fromFileInfos(file)
                igz.save(extractPath)

                const convertCmd = `"${exePath}" "${extractPath}" nst ${isActor ? 'act' : 'mod'}`
                try {
                    execSync(convertCmd)
                    console.log('Extracted', file.path, extractPath)
                }
                catch (e) {
                    console.warn(`Could not convert model ${name}`, e)
                }
                rmSync(extractPath)
            }

            ipcRenderer.send('set-progress-bar', null)

            // Load models
            models = Object.fromEntries(allModelFiles
                        .map(e => {
                                const name = e.path.split('/').pop().replace('.igz', '')
                                try {
                                    const fbx  = getModelFolder(name + '.fbx')
                                    return [name, {id: e.id, model: readFileSync(fbx)}]
                                }
                                catch {
                                    console.log(`Could not load model ${name}.fbx`)
                                    return null
                                }
                            })
                        .filter(e => e != null))
        }

        const show_all_objects = (localStorage.getItem('explorer-show-all-objects') ?? 'false') === 'true'

        const processObjects = (igz, type, callback) => {
            const objects = igz.objects.filter(e => e.type == type && e.references.length <= 1)
            const validObjects = []

            for (const object of objects) {
                const lowername = object.name.toLowerCase()
                if (!show_all_objects && ['levelendscene', 'cloud', 'shadow', , 'leaves', 'introisland', 'palmcluster', 'terrain', 'proxy'].some(e => lowername.includes(e))) continue
                const result = callback(igz, object)
                if (result) validObjects.push(result)
            }
            return validObjects
        }

        const loaded = {
            igEntities: [],
            CEntities: [],
            CGameEntities: [],
            CPhysicalEntities: []
        }

        const processNextFile = (index) => {
            this.renderer.render(this.scene, this.cam)

            const file = mapFiles[index]
            const title = 'Loading level files...'
            ipcRenderer.send('set-progress-bar', index, mapFiles.length, title, `Reading ${file.path.split('/').pop()}`, 'files processed')

            const igz = IGZ.fromFileInfos(file)
            
            const igEntities        = processObjects(igz, 'igEntity', this.process_igEntity)
            const CEntities         = processObjects(igz, 'CEntity', this.process_CEntity)
            const CGameEntities     = processObjects(igz, 'CGameEntity', this.process_CGameEntity)
            const CPhysicalEntities = processObjects(igz, 'CPhysicalEntity', this.process_CPhysicalEntity)
            const entities = igEntities.concat(CEntities).concat(CGameEntities).concat(CPhysicalEntities)

            loaded.igEntities.push(...igEntities)
            loaded.CEntities.push(...CEntities)
            loaded.CGameEntities.push(...CGameEntities)
            loaded.CPhysicalEntities.push(...CPhysicalEntities)

            for (const entity of entities) {
                if (entity == null) continue

                if (entity.name.includes('Collectible_Wumpa'))
                    entity.model_name = "crash_wumpafruit_no_sparkles"

                if (entity.model_name == null) {
                    this.loadModel(null, entity)
                    continue
                }

                const model_name = entity.model_name.split('\\').pop().replace('.igb', '')
                let fbx = models[model_name]

                if (fbx == null && this.hasModels) 
                    console.warn(`Could not find model ${model_name}`)

                this.loadModel(fbx, entity)
            }

            if (index < mapFiles.length - 1) 
                // requestAnimationFrame(() => processNextFile(index + 1))
                processNextFile(index + 1)
            else {
                ipcRenderer.send('set-progress-bar', null)
                this.renderer.render(this.scene, this.cam)
            }
        }

        processNextFile(0)
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

    loadModel(modelData, entity) {
        let { name, position, rotation, scale, color, parentPosition, controlPoints, type, model_name } = entity

        let model = modelData ? this.loader.parse(modelData.model.buffer) : new SphereGeometry(20, 20, 20)

        // Apply color
        const isCrate = name.includes('Crate_')
        if (isCrate) {
            if (!this.hasModels) model = new BoxGeometry(80, 80, 80)
            color = 0xfaba52
        }
        if (name.includes('Collectible_Wumpa')) {
            color = 0xffdd12
        }
        if (modelData == null && model_name == null && type == 'igEntity') {
            color = 0xf9fc9a
        }

        const fbx = modelData ? model : new Mesh(model, isCrate ? new MeshPhongMaterial({ color, shininess: 0 }) : new MeshBasicMaterial({ color }))
        fbx.userData = { ...entity }

        // Create splines (camera...)
        if (controlPoints) {
            controlPoints.forEach(e => e.position = e.position.map((v, i) => v + position[i]))
            this.createLine(controlPoints, 0xff0000, 0.001, true)
        }

        if (position[0] == 0 && position[1] == 0 && position[2] == 0) return

        // Link CEntity to spawners
        const show_entity_links = (localStorage.getItem('explorer-show-entity-links') ?? 'false') === 'true'
        if (show_entity_links && parentPosition && !(parentPosition[0] == 0 && parentPosition[1] == 0 && parentPosition[2] == 0)) {
            this.createLine([{position}, {position: parentPosition}], color, 0.005, false)
        }

        // Apply material
        if (modelData)
            fbx.traverse((child) => {
                if (child.isMesh) {
                    child.material = this.defaultMaterial.clone()
                    child.material.color.set(color ?? 0xffffff)
                }
            })

        // Set position
        fbx.position.set(...position)

        // Set rotation
        if (rotation) {
            fbx.rotateY(rotation[1])
            fbx.rotateZ(rotation[2])
            fbx.rotateX(rotation[0])
        }
        fbx.rotateY(-Math.PI/2)

        // Set scale
        if (scale)
            fbx.scale.set(...scale)

        // Add object to scene
        this.scene.add(fbx)
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
            
            if (intersects.length > 0 && intersects.some(e => e.object.parent?.parent?.type == "TransformControlsGizmo")) {
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

    if (this.type != 'CGameEntityData') console.log(`No model or skin found in ${this.getName()}`)
    return null
}

igObject.prototype.toMeshInfo = function(igz, { color = 0xffffff, transform = {}, ...props } = {}) {
    const convertVector = (v) => [-v[0], v[2], v[1]]
    
    const info = {
        igz: igz.path,
        name: this.getName(),
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