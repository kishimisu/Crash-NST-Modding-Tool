import { existsSync, readFileSync, writeFileSync } from "fs"
import IGZ from "../../../igz/igz"
import Pak from "../../../pak/pak"
import { bitRead, computeHash, extractName } from "../../../utils"
import { namespace_hashes } from "./metadata"
import { getArchiveFolder, getTextureFolder } from "./utils"

const convertPosition = ([x, y, z], [tx = 0, ty = 0, tz = 0] = []) => ([-x-tx, z+tz, y+ty])

function extractModelData(igz) {
    const igModelDrawCallData = igz.objects.filter(e => e.type === 'igModelDrawCallData')

    if (igModelDrawCallData == null || igModelDrawCallData.length == 0) 
        return console.warn('No draw call data for ' + igz.path)

    const igModelData = igz.objects.find(e => e.type === 'igModelData')
    const transforms = igModelData.extractMemoryData(igz, 0x40 + 8, 8).data.map(e => {
        const object = igz.findObject(e)
        if (object == null) return [0, 0, 0]
        return object.view.readVector(3, 0x50)
    })
    const transformHierarchy = igModelData.extractMemoryData(igz, 0x58 + 8).data
    const transformIndices = igModelData.extractMemoryData(igz, 0x88 + 8).data

    const getAnimatedTransform = (drawCallIndex) => {
        let transformIndex = transformIndices[drawCallIndex] - 1

        if (transformHierarchy[transformIndex] > 0) 
            transformIndex = transformHierarchy[transformIndex] - 1

        return transforms[transformIndex]
    }

    function processDrawCall(drawCall, index) {
        const igGraphicsVertexBuffer = drawCall.getChild('igGraphicsVertexBuffer')
        const igVertexBuffer = igGraphicsVertexBuffer.getChild('igVertexBuffer')
        const vertexData = extractVertexData(igVertexBuffer, null, index)
    
        const igGraphicsIndexBuffer  = drawCall.getChild('igGraphicsIndexBuffer')
        const igIndexBuffer = igGraphicsIndexBuffer.getChild('igIndexBuffer')
        const indexData = extractVertexData(igIndexBuffer, 2)

        const inRHND = drawCall.fixups.RHND.includes(0x40)
        let material = null

        if (inRHND) {
            const material_handle = drawCall.view.readUInt(0x40)
            
            if ((material_handle & 0x80000000) != 0) {
                const handle = material_handle & 0x7FFFFFFF
                material = igz.named_handles[handle]

                if (material[1] == 'Crash_Crates_materials,TNTCrate,0000100') {
                    material = ['TNT', 'Crash_Crates_materials']
                }
                if (material[0] == 'GrayWood01E' && material[1] == 'Crash_Crates_materials,Crash_Crate_Nitro,0000210') {
                    material = ['NitroWood', 'Crash_Crates_materials']
                }
            }
            else {
                console.warn(`Material handle is not a named handle for ${igz.path} in object ${drawCall.getName()}`)
            }
        }
        else console.warn('RHND not found in', igz.path)
    
        return { vertexData, indexData, material, index, modelName: igz.path }
    }
    
    function extractVertexData(igBuffer, elementSize, drawCallIndex) {
        if (elementSize == null) {
            const igVertexFormat = igBuffer.getChild('igVertexFormat')
            elementSize = igVertexFormat.view.readUInt(0x10)
        }
        const count      = igBuffer.view.readUInt(0x10)
        const dataOffset = igBuffer.view.readUInt(0x28 + 8)
        const dataObject = igz.findObject(dataOffset)
        const dataStart  = igz.getGlobalOffset(dataOffset) - dataObject.global_offset
        const hasPadding = [44, 52, 64, 76, 84, 140].includes(elementSize)
        const data = []
    
        for (let i = 0; i < count; i++) {
            dataObject.view.seek(dataStart + i * elementSize)
    
            if (elementSize == 2) {
                data.push(dataObject.view.readUInt16())
            }
            else if (elementSize == 24) {
                const position = dataObject.view.readVector(3)
                const uv = dataObject.view.readVectorHalf(2)
                const transform = getAnimatedTransform(drawCallIndex)
                data.push({ position: convertPosition(position, transform), normal: [0, 0, 0], uv })
            }
            else {
                const position = dataObject.view.readVector(3)
                const normal   = dataObject.view.readVector(3)
                if (hasPadding)  dataObject.view.skip(4)
                const uv = dataObject.view.readVectorHalf(2)
                const transform = getAnimatedTransform(drawCallIndex)
                data.push({ position: convertPosition(position, transform), normal: convertPosition(normal), uv })
            }
        }
    
        return data
    }

    const drawCalls = igModelDrawCallData.map(processDrawCall)
    return { drawCalls }
}

const TEXTURE_INFOS = JSON.parse(localStorage.getItem('texture-data')) ?? {}

function extractDrawcallTextureData(pak, drawCall, cache = false) {
    if (!drawCall.material) return null

    const [objectName, materialName] = drawCall.material
    const textureData = TEXTURE_INFOS[materialName]?.[objectName]
    
    if (cache && textureData && existsSync(textureData.imagePath)) {
        // Read cached texture
        const pixels = readFileSync(textureData.imagePath)
        return { pixels, ...textureData }
    }
    else {
        // Find drawcall material IGZ
        const materialFile = pak.files.find(e => extractName(e.path) == materialName)
        const materialIGZ = IGZ.fromFileInfos(materialFile)
        materialIGZ.setupEXID(getArchiveFolder(), pak)
        materialIGZ.setupChildrenAndReferences()

        // Get drawcall material object
        const Material = materialIGZ.objects.find(e => e.name == objectName)
        if (Material == null) throw new Error(`Object ${objectName} not found in ${materialName} for ${drawCall.modelName}`)
        
        const bitfield = Material.view.readUInt(0x20)
        const wrapS = bitRead(bitfield, 3, 20)
        const wrapT = bitRead(bitfield, 3, 23)
        if (wrapS != 1 || wrapT != 1) console.warn('Texture wrap not set to repeat', materialName, wrapS, wrapT)

        // Get diffuse color texture path
        const colorTextures = Material.getAllChildrenRecursive()
            .filter(e => e.type == 'igTextureAttr2')
            .map(e => {
                const inRHND = e.fixups.RHND.includes(0x50)
                if (!inRHND) return console.warn('RHND not found in', materialName)

                const handle = e.view.readUInt(0x50)
                if ((handle & 0x80000000) == 0) return console.warn('NOT A HANDLE', materialName)

                const textureName = materialIGZ.named_handles[handle & 0x7FFFFFFF][1]
                if (!textureName.startsWith('ColorMap') && !textureName.startsWith('CavityBakedColorMap')) return

                return textureName.toLowerCase()
            })
            .filter(e => e != null)
            .sort((a, b) => b.startsWith('cavitybakedcolormap') ? 1 : a.startsWith('colormap') ? 0 : -1)

        // Get color attribute
        const igColorAttr = Material.tryGetChildRecursive('igAttrList', 'igColorAttr')
        const color = igColorAttr ? igColorAttr.view.readVector(4, 0x20) : [1, 1, 1, 1]

        // Get alpha attribute
        const igBlendStateAttr = Material.tryGetChildRecursive('igAttrList', 'igBlendStateAttr')
        const transparent = igBlendStateAttr?.view.readByte(0x18) == 1
        
        const textureName = colorTextures[0]
        if (textureName == null) {
            console.warn('No color texture found for', materialName, objectName)
            return { color, transparent, type: Material.type }
        }

        // Get metal attribute (hack)
        let metal = false
        if (textureName.includes('c1_metalcrate_base_')) metal = true // C1_metalcrate_base_

        // Find texture file in current PAK
        let textureFile = pak.files.find(e => e.path.toLowerCase().includes(textureName))

        if (textureFile == null) {
            // If texture not found in current PAK, search in original PAK
            const hash = computeHash(textureName)
            const infos = namespace_hashes[hash]
            const texturePak = Pak.fromFile(getArchiveFolder(infos.pak))
            textureFile = texturePak.files.find(e => e.path.toLowerCase().includes(textureName))
            if (textureFile == null) {
                throw new Error('No texture file found for', textureName, materialName, objectName)
            }
        }

        // Load texture IGZ
        const textureIGZ = IGZ.fromFileInfos(textureFile)
        textureIGZ.setupEXID(getArchiveFolder(), pak)

        // Extract texture
        const igImage = textureIGZ.objects.find(e => e.type == 'igImage2')
        const { pixels, width, height } = igImage.extractTexture(textureIGZ)
        
        const textureData = { width, height, textureName, color, transparent, metal, type: Material.type }

        // Cache texture
        if (cache) {
            const imagePath = getTextureFolder(computeHash(textureName))
            writeFileSync(imagePath, Buffer.from(pixels))
            textureData.imagePath = imagePath

            TEXTURE_INFOS[materialName] ??= {}
            TEXTURE_INFOS[materialName][objectName] = textureData
            console.log('Saved texture data for', materialName, objectName)
        }

        return { pixels, ...textureData }
    }
}

export { 
    extractModelData,
    extractDrawcallTextureData,
    TEXTURE_INFOS
}