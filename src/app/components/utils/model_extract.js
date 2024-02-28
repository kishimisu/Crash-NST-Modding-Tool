import igObject from "../../../igz/igObject"

const convertPosition = ([x, y, z], [tx = 0, ty = 0, tz = 0] = []) => ([-x-tx, z+tz, y+ty])

function extractModelData(igz) {
    const igModelDrawCallData = igz.objects.filter(e => e.type === 'igModelDrawCallData')

    if (igModelDrawCallData == null || igModelDrawCallData.length == 0) 
        return console.warn('No draw call data for ' + igz.path)

    const igModelData = igz.objects.find(e => e.type === 'igModelData')
    const transforms = igModelData.extractMemoryData(igz, 0x40 + 8, 8).map(e => {
        const object = igz.findObject(e)
        if (object == null) return [0, 0, 0]
        return object.view.readVector(3, 0x50)
    })
    const transformHierarchy = igModelData.extractMemoryData(igz, 0x58 + 8)
    const transformIndices = igModelData.extractMemoryData(igz, 0x88 + 8)

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
    
        return { vertexData, indexData }
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

igObject.prototype.extractMemoryData = function(igz, offset, elementSize = 4) {
    const memSize = this.view.readUInt(offset)
    const dataOffset = this.view.readUInt(offset + 8)
    const elementCount = memSize / elementSize
    const object = igz.findObject(dataOffset)
    const startOffset = igz.getGlobalOffset(dataOffset) - object.global_offset
    
    const data = []
    for (let i = 0; i < elementCount; i++) {
        data.push(object.view.readUInt(startOffset + i * elementSize))
    }

    return data
}

export { 
    extractModelData,
}