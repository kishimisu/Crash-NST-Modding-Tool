import HavokFile from "../../../havok/havok"
import { computeHash, extractName } from "../../../utils"
import hkxCollisionTemplate from "../../../../assets/crash/collision_template.hkx"

function addCollisionToObject(object, callback) {
    if (object.type != 'igEntity') throw new Error('Object is not an igEntity')
    
    // Get model TSTR index
    const igEntityData = object.getChild('igEntityData')
    const igComponentDataTable = igEntityData.getChild('igComponentDataTable')
    const CModelComponentData = igComponentDataTable.getChild('CModelComponentData')
    const string_index = CModelComponentData.view.readUInt(0x18)

    // Find corresponding .igz and .hkx files
    const namespace = extractName(Main.igz.fixups.TSTR.data[string_index].replaceAll('\\', '/'))
    const model_file = Main.pak.files.find(e => extractName(e.path) == namespace && e.path.endsWith('.igz'))
    const collision_file = Main.pak.files.find(e => extractName(e.path) == namespace && e.path.endsWith('.hkx'))

    // Create collision file if it doesn't exist
    if (collision_file == null) {
        callback('Constructing collision file...')

        const objectHash = object.original_name_hash ?? computeHash(object.name)
        createCollisionFile(Main.pak, objectHash, Main.igz.path, model_file.path)
    }

    // Create CGameEntity
    const CGameEntity     = Main.igz.createObject('CGameEntity', object.name)
    const CGameEntityData = Main.igz.createObject('CGameEntityData', object.name + '_entityData')
    const igComponentList = Main.igz.createObject('igComponentList')
    const newObjects = [CGameEntity, CGameEntityData, igComponentList]

    // Add path without extension to TSTR
    const str_id = Main.igz.addTSTR(model_file.path.slice(0, -4))

    const position  = object.view.readVector(3, 0x20)
    const transform = object.tryGetChild('igEntityTransform')

    // Copy previous transform
    if (transform) {
        const [igEntityTransform] = Main.igz.cloneObject(transform)
        CGameEntity.activateFixup('ROFS', 0x30, true, igEntityTransform)
        newObjects.push(igEntityTransform)
    }

    // Init CGameEntity
    CGameEntity.view.setUInt(65665, 0x38)       // _bitfield
    CGameEntity.view.setVector(position, 0x20)  // _parentSpacePosition
    CGameEntity.activateFixup('ROFS', 0x18, true, igComponentList) // _components
    CGameEntity.activateFixup('ROFS', 0x40, true, CGameEntityData) // _entityData

    // Init CGameEntityData
    CGameEntityData.view.setFloat(1, 0x18)      // _scale
    CGameEntityData.view.setUInt(2879492, 0x20) // _entityFlags
    CGameEntityData.view.setUInt(32, 0x24)      // _actionEntityFlags
    CGameEntityData.view.setUInt(2, 0x3C)       // _distanceCullImportance
    CGameEntityData.view.setUInt(1, 0x44)       // _collisionPriority
    CGameEntityData.view.setUInt(1, 0x68)       // _castsShadows
    CGameEntityData.view.setUInt(1024, 0x78)    // _cachedAssetPool
    CGameEntityData.activateFixup('RSTT', 0x48, true, str_id) // _modelName

    // Delete igEntity
    Main.igz.deleteObject(object, true)

    callback('Updating IGZ...')

    // Update IGZ
    Main.igz.updateObjects(newObjects)
    Main.igz.setupChildrenAndReferences(localStorage.getItem('display-mode'), true)

    return CGameEntity
}

function createCollisionFile(pak, object_hash, filename, model_path) {
    // Find collision item in StaticCollision.igz file
    const collisionItem = pak.getCollisionItem(object_hash, filename)

    if (collisionItem == null) throw new Error(`Collision item not found for ${model_path} in ${filename}`)

    // Instanciate StaticCollision.hkx file
    const fileInfosHkx = pak.files.find(e => e.path.includes('StaticCollision_') && e.path.endsWith('.hkx'))
    const staticHkx = HavokFile.fromFileInfos(fileInfosHkx)

    // Find shape start/end objects
    const shapes    = staticHkx.objects.filter(e => e.type == 'hknpShapeInstance').map(e => e.children[0])
    const shape     = shapes[collisionItem.value]
    const nextShape = shapes.sort((a, b) => a.offset - b.offset).find(e => e.offset > shape?.offset)
    
    if (shape == null || nextShape == null)  throw new Error(`hknpShapeInstance error for ${model_path} in ${filename}`)

    // Build new collision file
    const data = buildCollisionFileFromTemplate(staticHkx, shape, nextShape)

    // Add new file to pak
    pak.createFile(model_path.replace('.igz', '.hkx'), data)
}

function buildCollisionFileFromTemplate(staticHkx, startObject, endObject) {
    // Instantiate template
    const template = new HavokFile(new Uint8Array(hkxCollisionTemplate))

    // Get new data from static file
    const staticHkxStart = startObject.offset
    const staticHkxEnd   = endObject.offset
    const staticHkxData  = staticHkx.reader.buffer.slice(staticHkxStart, staticHkxEnd)

    // Update template object buffer
    const newBuffer = new Uint8Array(template.objectsBuffer.length + staticHkxData.length)
    newBuffer.set(template.objectsBuffer)
    newBuffer.set(staticHkxData, template.objectsBuffer.length)
    template.objectsBuffer = newBuffer

    // Find fixups pointing to the objects in the static file
    const staticFixups = staticHkx.dataSection.getFixupsInRange(staticHkxStart, staticHkxEnd)
    
    // Update new fixups offsets
    const increment = staticHkx.dataSection.dataOffset + template.dataSection.fixupOffset - staticHkxStart

    const updateFixups = (fixup) => {
        const lastFixup = template.dataSection[fixup].pop()
        staticFixups[fixup].forEach(e => {
            e.pointer += increment
            e.destination += increment
            template.dataSection[fixup].push(e)
        })
        template.dataSection[fixup].push(lastFixup)
    }
    updateFixups('localFixups')
    updateFixups('globalFixups')
    updateFixups('virtualFixups')

    // Update fixup start offset
    template.dataSection.fixupOffset += staticHkxData.length

    // Add new objects
    template.objects.push(...staticHkx.objects.filter(e => e.offset >= staticHkxStart && e.offset < staticHkxEnd))

    return template.save()
}

export { addCollisionToObject }