import { AmbientLight, DirectionalLight, MeshBasicMaterial, MeshPhongMaterial, PerspectiveCamera, Scene, WebGLRenderer, Vector3, Raycaster, Vector2, Euler, Mesh, SphereGeometry, DoubleSide, FogExp2, BufferGeometry, Float32BufferAttribute, Group, Color, DataTexture, RGBAFormat, UnsignedByteType, RepeatWrapping } from 'three'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls'
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { elm, getArchiveFolder } from './utils/utils'
import IGZ from '../../igz/igz'
import ObjectView from './object_view'
import { ipcRenderer } from 'electron'
import { extractDrawcallTextureData, extractModelData } from './utils/model_extract';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { extractName } from '../../utils';

const convertVector = (v) => [-v[0], v[2], v[1]]

class LevelExplorer {
    constructor() {
        this.visible = false
        this.initialized = false
        this.mode = 'level' // level, model
        this.models = {}

        elm('#focus-in-explorer').addEventListener('click', () => this.focusObject(Main.objectView.object))
        elm('#hide-explorer').addEventListener('click', () => this.toggleVisibility(false))

        window.addEventListener('keydown', function(e) {
            // Prevent spacebar from scrolling
            if(e.target == document.body && e.code == 'Space') {
              e.preventDefault()
            }
        })
    }

    focusObject(object, updateCamera = true) {
        if (!this.initialized) this.init()
        else {
            this.toggleVisibility(true)
            this.clearModelScene()
        }

        const match = this.scene.children.find(e => e.userData?.igz == Main.igz.path && e.userData?.objectIndex == object.index)

        if (match) {
            if (updateCamera) {
                this.cam.position.set(match.position.x, match.position.y + 100, match.position.z - 200)
                this.cam.lookAt(match.position)
            }
            this.transformControls.attach(match)

            this.lastObject?.children?.forEach(e => e.material.color.set(this.lastColor))
            this.lastObject = match
            this.lastColor = match.children?.length > 0 ? match.children[0].material.color.clone() : match.material.color.clone()
            match.children?.forEach(e => e.material.color.set(0xeda93b))

            this.renderer.render(this.scene, this.cam)
        }
    }

    toggleVisibility(visible) {
        elm('#explorer').style.display = visible ? 'block' : 'none'
        elm('#data-table-ctn').style.display = visible ? 'none' : 'block'
        elm('#canvas').style.display = visible ? 'block' : 'none'
        elm('#canvas-2d').style.display = 'none'
        this.visible = visible
        if (!visible) this.deselectObject()
    }

    toggleShowTextures(checked) {
        localStorage.setItem('explorer-show-textures', checked)
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

    showModelScene(igz) {
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
            if (mesh == null) continue

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

    exportDDS(pixels, width, height, filename) {
        const header = new ArrayBuffer(128);
        const headerView = new DataView(header);

        // DDS header
        headerView.setUint32(0, 0x20534444, true);
        headerView.setUint32(4, 124, true);
        headerView.setUint32(8, 0x81007, true);
        headerView.setUint32(12, height, true);
        headerView.setUint32(16, width, true);
        headerView.setUint32(20, width * 4, true);
        headerView.setUint32(28, 0, true);
        headerView.setUint32(76, 32, true);
        headerView.setUint32(80, 0x41, true);
        headerView.setUint32(84, 0, true);
        headerView.setUint32(88, 32, true);
        headerView.setUint32(92, 0x00FF0000, true);
        headerView.setUint32(96, 0x0000FF00, true);
        headerView.setUint32(100, 0x000000FF, true);
        headerView.setUint32(104, 0xFF000000, true);
        headerView.setUint32(108, 0x1000, true);
        headerView.setUint32(112, 0, true);
        headerView.setUint32(116, 0, true);
        headerView.setUint32(120, 0, true);

        const flippedPixels = new Uint8Array(pixels.length);
        const rowSize = width * 4;

        for (let y = 0; y < height; y++) {
           const srcRowStart = (height - 1 - y) * rowSize;
           const destRowStart = y * rowSize;
    
            for (let x = 0; x < rowSize; x += 4) {
                flippedPixels[destRowStart + x] = pixels[srcRowStart + x + 2]; // B -> R
                flippedPixels[destRowStart + x + 1] = pixels[srcRowStart + x + 1]; // G
                flippedPixels[destRowStart + x + 2] = pixels[srcRowStart + x]; // R -> B
                flippedPixels[destRowStart + x + 3] = pixels[srcRowStart + x + 3]; // A
            }
        }

        const ddsData = new Uint8Array(128 + flippedPixels.length);
        ddsData.set(new Uint8Array(header), 0);
        ddsData.set(flippedPixels, 128);

        const blob = new Blob([ddsData], { type: 'application/octet-stream' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = filename + '.dds';
        link.click();
    }

    sanitizeFilename(path) {
        const baseName = path.split('/').pop().split('\\').pop();

        return baseName.replace(/[^a-zA-Z0-9-_\.]/g, '_').replace(/\.\w+$/, '');
    }

    showTexture(igz) {
        const igImage = igz.objects.find(e => e.type == 'igImage2');
        if (!igImage) return console.warn('No igImage2 object found in', igz.path);

        const { pixels, width, height } = igImage.extractTexture(igz);

        const canvas = elm('#canvas-2d');
        elm('#explorer').style.display = 'flex';
        elm('#canvas').style.display = 'none';
        canvas.width = width;
        canvas.height = height;
        canvas.style.display = 'block';
        canvas.style.aspectRatio = `${width}/${height}`;

        const ctx = canvas.getContext('2d');
        const imageData = ctx.createImageData(width, height);
        for (let i = 0; i < pixels.length; i++) {
            imageData.data[i] = pixels[i];
        }
        ctx.putImageData(imageData, 0, 0);
        canvas.style.transform = 'scale(1, -1)';
        this.visible = false;

        // export as DDS
        this.exportDDS(pixels, width, height, this.sanitizeFilename(igz.path));
    }

    clearModelScene() {
        if (this.mode == 'level') return
        this.mode = 'level'
        this.model_scene = null
        this.model_cam = null
        this.model_controls.dispose()
        this.model_controls = null
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

    init(reset_camera_location = false) {
        if (!this.initialized) {
            if (!this.renderer) this.initRenderer()
            this.scene = new Scene()
            this.cam = new PerspectiveCamera(75, canvas.width / canvas.height, 1, 50000)
            this.cam.position.set(-40, 600, -1000)

            this.transformControls = new TransformControls(this.cam, this.renderer.domElement)
            this.transformControls.setMode('translate')

            let timeout = null
            this.transformControls.addEventListener('objectChange', () => {
                clearTimeout(timeout)
                timeout = setTimeout(() => {
                    const object3D = this.transformControls.object
                    if (object3D) {
                        const object = Main.igz.objects[object3D.userData.objectIndex]
                        if (Main.objectView?.object != object) {
                            Main.objectView = new ObjectView(object)
                            Main.focusObject(object.index)
                        }
                        const field = object.type == 'igSplineControlPoint2' ? 1 : 3
                        const parentPosition = object3D.userData.splineParentPosition ?? [0, 0, 0]
                        Main.objectView.onFieldUpdate(Main.objectView.fields[field], (-object3D.position.x + parentPosition[0]).toFixed(3), 0)
                        Main.objectView.onFieldUpdate(Main.objectView.fields[field], (object3D.position.z - parentPosition[2]).toFixed(3), 1)
                        Main.objectView.onFieldUpdate(Main.objectView.fields[field], (object3D.position.y - parentPosition[1]).toFixed(3), 2)
                    }
                }, 500)
            })
            
            this.controls = new NoClipControls(this)
            
            this.raycaster = new Raycaster()

            this.lastObject = null
            this.lastColor  = null

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

                    this.lastObject?.children?.forEach(e => e.material.color.set(this.lastColor))

                    if (object != null) {
                        this.lastObject = object
                        this.lastColor = object.children?.length > 0 ? object.children[0].material.color.clone() : object.material.color.clone()

                        const objectData = object.userData
                        
                        if (!Main.igz || Main.treeMode == 'pak' || Main.igz.path != objectData.igz) {
                            const confirm = !Main.igz?.updated || await ipcRenderer.invoke('show-confirm-message', 'You have unsaved changes. Do you want to continue?')
                            if (!confirm) return
                            const fileIndex = Main.pak.files.findIndex(e => e.path == objectData.igz)
                            const fileInfos = Main.pak.files[fileIndex]
                            const filePath  = fileInfos.path

                            const showProgress = fileInfos.size > (filePath.startsWith('maps/') ? 1_000_000 : 2_400_000)
                            if (showProgress) ipcRenderer.send('set-progress-bar', 1, null, 'Loading', 'Loading...', 'Loading ' + filePath.split('/').pop())
                            
                            try {
                                Main.setIGZ(IGZ.fromFileInfos(fileInfos))
                                Main.igz.setupEXID(getArchiveFolder(), Main.pak)
                                Main.igz.setupChildrenAndReferences(localStorage.getItem('display-mode') ?? 'root')
                            }
                            catch (e) {
                                console.error(e)
                                ipcRenderer.send('show-error-message', 'An error occurred while loading the file', e.message)
                                return
                            }
                            finally {
                                if (showProgress) ipcRenderer.send('set-progress-bar', null)
                            }

                            Main.showIGZTree()
                            Main.lastFileIndex.igz = fileIndex
                        }

                        object.children?.forEach(e => e.material.color.set(0xeda93b))
                        this.transformControls.attach(object)

                        const igObject = Main.igz.objects[objectData.objectIndex]
                        Main.objectView = new ObjectView(igObject)
                        Main.focusObject(objectData.objectIndex)
                    }
                    else {
                        this.transformControls.detach()
                    }
                }
            })

            const fog = new FogExp2(0x2661ab, 0.00004)
            this.scene.fog = fog

            this.render()
        }

        this.pak = Main.pak
        this.scene.clear()
        this.toggleVisibility(true)
        this.clearModelScene()

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

        this.transformControls.detach()
        this.scene.add(this.transformControls)

        const modelFiles = []
        const mapFiles   = []
        const showGrass = (localStorage.getItem('explorer-show-grass') ?? 'false') === 'true'

        try {
            // Find model and map files
            for (const file of Main.pak.files) {
                if (!file.path.endsWith('.igz')) continue

                if (file.path.startsWith('actors/') || file.path.startsWith('models/') && !file.path.includes('Designer_Level_Template')) {
                    if (showGrass || !file.path.includes('Grass'))
                    modelFiles.push(file)
                }
                else if (file.path.startsWith('maps/') && file.include_in_pkg)
                    mapFiles.push(file)
            }

            this.models = {}
            
            // Create model meshes
            for (let i = 0; i < modelFiles.length; i++) {
                const file = modelFiles[i]
                const name = file.path.split('/').pop()

                const title = 'Constructing models'
                ipcRenderer.send('set-progress-bar', i, modelFiles.length, title, `Reading file ${name}`, 'models loaded')

                const igz = IGZ.fromFileInfos(file)
                igz.setupChildrenAndReferences()
                const modelData = extractModelData(igz)
                if (modelData == null) continue
                const { drawCalls } = modelData

                const group = new Group()
                for (let j = 0; j < drawCalls.length; j++) {
                    const drawCall = drawCalls[j]
                    const mesh = this.createMesh(drawCall)
                    if (mesh == null) continue
                    group.add(mesh)
                }
                this.models[name.replace('.igz', '')] = group
            }

            // Load level files
            const processNextFile = (index = 0) => {
                this.renderer.render(this.scene, this.cam)

                const file = mapFiles[index]
                const title = 'Loading level files...'
                ipcRenderer.send('set-progress-bar', index, mapFiles.length, title, `Reading ${file.path.split('/').pop()}`, 'files processed')

                let igz = Main.igz

                if (igz == null || igz.path != file.path) {
                    igz = IGZ.fromFileInfos(file)
                    igz.setupChildrenAndReferences()
                }
                
                const { CPlayerStartEntity } = this.process_igz(igz)

                // Set camera start position if PlayerStartAll found
                const playerStart = CPlayerStartEntity.find(e => e.name.toLowerCase().includes('playerstartall'))?.position
                if (playerStart != null && reset_camera_location) {
                    this.cam.position.set(playerStart[0], playerStart[1] + 200, playerStart[2] - 300)
                    this.cam.rotation.set(0, Math.PI, 0)
                }

                if (index < mapFiles.length - 1) 
                    processNextFile(index + 1)
                else {
                    ipcRenderer.send('set-progress-bar', null)
                    this.renderer.render(this.scene, this.cam)
                    this.initialized = true
                }
            }

            if (mapFiles.length > 0)
                processNextFile()
        }
        catch (e) {
            ipcRenderer.send('set-progress-bar', null)
            ipcRenderer.send('show-error-message', 'An error occurred while loading models', e.message)
            console.error(e)
        }
    }

    addObject(object) {
        if (!this.initialized) return
        if (!['igEntity', 'CGameEntity', 'CActor', 'CEntity', 'CPlayerStartEntity', 'CScriptTriggerEntity', 'CWaypoint'].includes(object.type)) return
        
        const entity = this[`process_${object.type}`](Main.igz, object)
        this.loadEntity(entity)
        this.renderer.render(this.scene, this.cam)
    }

    process_igz(igz) {
        const showGrass = (localStorage.getItem('explorer-show-grass') ?? 'false') === 'true'
        const show_all_objects = (localStorage.getItem('explorer-show-all-objects') ?? 'false') === 'true'
        const hidden_objects = ['cloud', 'shadow', 'palmcluster', 'palmtrees', 'treeplane', 'levelendscene', 'bonusround']

        const processObjects = (type, callback) => {
            const objects = igz.objects.filter(e => e.type == type)
            const validObjects = []

            for (const object of objects) {
                try {
                    const lowername = object.name.toLowerCase()
                    if (!showGrass && lowername.includes('grass')) continue
                    if (!show_all_objects && hidden_objects.some(e => lowername.includes(e))) continue
                    if (!show_all_objects && object.references.some(e => hidden_objects.some(h => e.name.toLowerCase().includes(h)))) continue
                    const result = callback.bind(this, igz, object)()
                    if (result) validObjects.push(result)
                }
                catch (e) {
                    console.warn('Error processing object', object.name, e)
                }
            }
            return validObjects
        }

        const igEntities         = processObjects('igEntity', this.process_igEntity)
        const CEntities          = processObjects('CEntity', this.process_CEntity)
        const CGameEntities      = processObjects('CGameEntity', this.process_CGameEntity)
        const CPhysicalEntities  = processObjects('CPhysicalEntity', this.process_CPhysicalEntity)
        const CPlayerStartEntity = processObjects('CPlayerStartEntity', this.process_CPlayerStartEntity)
        const CActors            = processObjects('CActor', this.process_CActor)
        const CScriptTriggerEntities = processObjects('CScriptTriggerEntity', this.process_CScriptTriggerEntity)
        const CWaypoints         = processObjects('CWaypoint', this.process_CWaypoint)
        const entities           = igEntities.concat(CEntities).concat(CGameEntities).concat(CPlayerStartEntity).concat(CActors)
                                             .concat(CScriptTriggerEntities).concat(CPhysicalEntities).concat(CWaypoints)

        // Load entities
        for (const entity of entities) {
            this.loadEntity(entity)
        }

        return { igEntities, CEntities, CGameEntities, CPlayerStartEntity, CActors }
    }

    process_igEntity(igz, object) 
    {
        const igEntityData         = object.getChild('igEntityData')
        const igComponentDataTable = igEntityData.getChild('igComponentDataTable')
        const CModelComponentData  = igComponentDataTable.tryGetChild('CModelComponentData')
        
        let model_name, color

        if (CModelComponentData) {
            model_name = CModelComponentData.getModel(igz)
        }
        else {
            const CPhysicalEntity = igComponentDataTable.tryGetChildRecursive('igPrefabComponentData', 'igEntityList', 'CPhysicalEntity')
            const CPhysicalEntityData = CPhysicalEntity?.getChild('CPhysicalEntityData')

            if (CPhysicalEntityData) {
                model_name = CPhysicalEntityData.getModel(igz)
                color = 0xee222e
            }
        }

        if (model_name == null) return object.toMeshInfo(igz)

        const igEntityTransform = object.tryGetChild('igEntityTransform')
        const transform = igEntityTransform?.getTransform()

        return object.toMeshInfo(igz, { model_name, transform, color })
    }

    process_igSpline2(igz, object)
    {
        const igSplineControlPoint2List = object.tryGetChild('igSplineControlPoint2List')
        const controlPoints = igSplineControlPoint2List?.children.map(e => e.object.toMeshInfo(igz, {position: e.object.view.readVector(3, 0x10)}))

        const distanceBetween = (v1, v2) => Math.sqrt(v1.map((e, i) => (e - v2[i]) ** 2).reduce((a, b) => a + b, 0))
        
        let distance = 0
        let lastPosition = controlPoints[0].position
        let controlPointDistances = []

        for (let i = 1; i < controlPoints.length; i++) {
            const position = controlPoints[i].position
            const dist = distanceBetween(position, lastPosition)
            distance += dist
            controlPointDistances.push({position, distance})
            lastPosition = position
        }

        const closestPoint = (distance) => {
            let closest = 0
            for (let i = 1; i < controlPointDistances.length; i++) {
                if (controlPointDistances[i].distance > distance) break
                closest = i
            }
            let p1 = controlPointDistances[closest]
            let p2 = controlPointDistances[closest + 1]
            let interp = (distance - p1.distance) / (p2.distance - p1.distance)
            return p1.position.map((e, i) => e + (p2.position[i] - e) * interp)
        }
        
        const igSplineEventList = object.tryGetChildRecursive('igSplineEventTrack', 'igSplineEventList')
        const splineMarkers = igSplineEventList?.children.map((e, i) => {
            const distance = e.object.view.readFloat(0x10)
            const position = closestPoint(distance)
            const infos = e.object.toMeshInfo(igz, { color: 0x5fbfaf})
            infos.position = position
            return infos
        })

        return { controlPoints, splineMarkers }
    }

    process_CEntity(igz, object) 
    {
        if (object.name.endsWith('_gen')) return null

        const CEntityData          = object.getChild('CEntityData')
        const igComponentDataTable = CEntityData.getChild('igComponentDataTable')
        const CVscComponentData    = igComponentDataTable.tryGetChild('CVscComponentData', 'CommonSpawnerTemplate')
        let color = 0x77ff6b

        const igEntityTransform = object.tryGetChild('igEntityTransform')
        const originalTransform = igEntityTransform?.getTransform()

        const show_splines = (localStorage.getItem('explorer-show-splines') ?? 'true') === 'true'
        let controlPoints = null
        let splineMarkers = null
        let parentPosition = null
        if (show_splines) {
            const igSpline2 = CEntityData.tryGetChildRecursive('igComponentDataTable', 'CSplineComponentData', 'igSpline2')
            if (igSpline2) {
                const splineData = this.process_igSpline2(igz, igSpline2)
                controlPoints = splineData.controlPoints
                splineMarkers = splineData.splineMarkers
                parentPosition = object.view.readVector(3, 0x20)
            }
        }

        if (!CVscComponentData) return object.toMeshInfo(igz, {color, controlPoints, splineMarkers, parentPosition, originalTransform}) 

        const EntityToSpawn = CVscComponentData.view.readUInt(0x48)

        if ((EntityToSpawn & 0x80000000) == 0) {
            console.warn('[CEntity] NOT A HANDLE', object.name, EntityToSpawn)
            return object.toMeshInfo(igz, {color, controlPoints, splineMarkers, parentPosition, originalTransform})
        }

        const spawnerName = igz.named_handles[EntityToSpawn & 0x7FFFFFFF][0]
        const Entity = igz.objects.find(e => e.name == spawnerName)

        if (!Entity) return console.warn('[CEntity] No object found for', object.name)
        if (!['CPhysicalEntity', 'CGameEntity', 'CActor'].includes(Entity.type)) return object.toMeshInfo(igz, {color, controlPoints, splineMarkers, parentPosition, originalTransform})

        const EntityData = Entity.getChild(Entity.type + 'Data')
        const model_name = EntityData.getModel(igz)

        const igParentTransform = Entity.tryGetChild('igEntityTransform')
        const transform = igParentTransform?.getTransform() ?? igEntityTransform?.getTransform() ?? {}
        parentPosition = Entity.view.readVector(3, 0x20)

        return object.toMeshInfo(igz, { model_name, transform, color, parentPosition, controlPoints, splineMarkers, originalTransform})
    }

    process_CGameEntity(igz, object) 
    {
        const CGameEntityData = object.getChild('CGameEntityData')
        const model_name = CGameEntityData.getModel(igz)
        const color = 0x63edff

        const show_splines = (localStorage.getItem('explorer-show-splines') ?? 'true') === 'true'
        let controlPoints = null
        let splineMarkers = null
        let parentPosition = [0,0,0]
        if (show_splines) {
            const igSpline2 = CGameEntityData.tryGetChildRecursive('igComponentDataTable', 'CSplineComponentData', 'igSpline2')
            if (igSpline2) {
                const splineData = this.process_igSpline2(igz, igSpline2)
                controlPoints = splineData.controlPoints
                splineMarkers = splineData.splineMarkers
                parentPosition = object.view.readVector(3, 0x20)
            }
        }

        const igEntityTransform = object.tryGetChild('igEntityTransform')
        const transform = igEntityTransform?.getTransform()

        return object.toMeshInfo(igz, { model_name, transform, color, controlPoints, splineMarkers, parentPosition })
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

    process_CScriptTriggerEntity(igz, object)
    {
        const EntityData = object.getChild('CScriptTriggerEntityData')
        const model_name = EntityData.getModel(igz)
        const color = 0xffa500

        const igEntityTransform = object.tryGetChild('igEntityTransform')
        const transform = igEntityTransform?.getTransform()

        return object.toMeshInfo(igz, { model_name, transform, color })
    }

    process_CWaypoint(igz, object) 
    {
        return object.toMeshInfo(igz, {color: 0x5faaff})
    }

    process_CActor(igz, object)
    {
        const CActorData = object.getChild('CActorData')
        const model_name = CActorData.getModel(igz)
        const color = 0xffff00

        const igEntityTransform = object.tryGetChild('igEntityTransform')
        const transform = igEntityTransform?.getTransform()

        return object.toMeshInfo(igz, { model_name, transform, color })
    }

    process_CPlayerStartEntity(igz, object)
    {
        return object.toMeshInfo(igz, {color: 0xff00ff})
    }

    createMesh(drawCall) {
        const path = extractName(drawCall.modelName).toLowerCase()
        if (path == 'crash_crate_checkpoint' && drawCall.index == 0) return

        const showTextures = (localStorage.getItem('explorer-show-textures') ?? 'false') === 'true'
        const texture = showTextures || this.mode == 'model' ? extractDrawcallTextureData(Main.pak, drawCall) : null

        const color = texture?.color ? new Color(...texture.color) : 0xffffffff
        const geometry = new BufferGeometry()
        const material = new MeshPhongMaterial({ color, shininess: 150, side: DoubleSide })
    
        if (texture?.transparent) {
            material.transparent = true
        }
        else if (texture?.type == 'CWaterMaterial' || texture?.type == 'CFlowWaterMaterial') {
            material.transparent = true
            material.opacity = 0.25
        }

        const vertices = drawCall.vertexData.map(e => e.position).flat()
        const normals  = drawCall.vertexData.map(e => e.normal).flat()
        const uvs      = drawCall.vertexData.map(e => e.uv).flat()
        const indices  = drawCall.indexData.slice()
    
        geometry.setAttribute('position', new Float32BufferAttribute(vertices, 3))
        geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3))
        geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2))
        geometry.setIndex(indices)

        if (path.includes('water')) {
            material.color = new Color(0x1278ff)
            material.transparent = true
            material.opacity = 0.5
        }
        else if (texture?.pixels) {
            const textureData = new Uint8Array(texture.pixels)
            const tex = new DataTexture(textureData, texture.width, texture.height, RGBAFormat, UnsignedByteType)
            tex.needsUpdate = true
            tex.wrapS = RepeatWrapping
            tex.wrapT = RepeatWrapping
            material.map = tex
        }
    
        const mesh = new Mesh(geometry, material)

        if (path == 'l101_nsanitybeach_terrain01' && drawCall.index == 1) 
            mesh.translateY(1)

        return mesh
    }

    loadEntity(entity) {
        if (entity == null) return

        const showTextures = (localStorage.getItem('explorer-show-textures') ?? 'false') === 'true'

        let { igz, name, model_name, position, rotation, scale, color, parentPosition, controlPoints, splineMarkers, originalTransform, objectHash } = entity
        let model = null

        if (model_name != null) {
            model_name = model_name.split('\\').pop().split('/').pop().replace('.igb', '')
            model = this.models[model_name]

            if (model == null) console.warn(`Could not find model ${model_name}`)
            else model = model.clone()
        }
        
        // Apply custom color
        const lower = name.toLowerCase()

        if (color == 0xffffff && Main.pak.getCollisionItem(objectHash, igz)) { // Object has StaticCollision
            color = 0xffdfba
        }

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
            const rotation = originalTransform ? convertVector(originalTransform.rotation) : [0,0,0]
            this.createLine(controlPoints, position, rotation, model == null ? 0xff0000 : color, 0.001, true)
        }
        if (splineMarkers) {
            splineMarkers.forEach(point => {
                const dot = new SphereGeometry(20, 20, 20)
                const sphere = new Mesh(dot, new MeshBasicMaterial({ color: 0xff00ff }))
                sphere.position.set(...point.position.map((v, i) => v + parentPosition[i]))
                sphere.userData = { ...point }
                this.scene.add(sphere)
            })
        }

        if (position[0] == 0 && position[1] == 0 && position[2] == 0) {
            if (name.endsWith('_gen')) return
            console.log('No position for', name)
        }

        // Link CEntity to spawners
        const show_entity_links = (localStorage.getItem('explorer-show-entity-links') ?? 'false') === 'true'
        if (show_entity_links && parentPosition && !(parentPosition[0] == 0 && parentPosition[1] == 0 && parentPosition[2] == 0)) {
            this.createLine([{position}, {position: parentPosition}], [0,0,0], [0,0,0], color, 0.005, false)
        }
        
        if (model == null) {
            const geo = new SphereGeometry(20, 20, 20)
            const mat = new MeshBasicMaterial()
            model = new Mesh(geo, mat)
        }
        model.userData = { ...entity }

        // Apply material
        model.traverse((child) => {
            if (child.isMesh) {
                child.material = child.material.clone()
                if (!showTextures)
                    child.material.color.set(color ?? 0xffffff)
            }
        })

        // Set position
        const prevent_z_fighting = Math.random() * .5 - .25
        model.position.set(...position.map(e => e + prevent_z_fighting))

        // Set rotation
        if (rotation) {
            model.rotateY(rotation[1])
            model.rotateZ(rotation[2])
            model.rotateX(rotation[0])
        }

        // Set scale
        if (scale)
            model.scale.set(...scale)

        // Add object to scene
        this.scene.add(model)
    }

    createLine(points, parentPosition, parentRotation, color, width, addMarkers = true) {
        const geo = new LineGeometry()
        const vector = new Vector3()
        const euler = new Euler(...parentRotation, 'YZX')
        const applyRotation = (v) => vector.fromArray(v).applyEuler(euler).toArray()

        points.forEach(e => e.position = applyRotation(e.position))
        points.forEach(e => e.position = e.position.map((v, i) => v + parentPosition[i]))
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
                const dot = new SphereGeometry(10, 10, 10)
                const sphere = new Mesh(dot, new MeshBasicMaterial({ color }))
                sphere.position.set(...point.position)
                sphere.userData = { ...point, splineParentPosition: parentPosition }
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
            
            if (this.explorer.transformControls.object != null && intersects.length > 0 && intersects.some(e => e.object.name != 'DELTA' && e.object.parent?.parent?.type == "TransformControlsGizmo")) {
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

export default LevelExplorer
