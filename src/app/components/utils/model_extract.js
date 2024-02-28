const convertPosition = ([x, y, z]) => ([-x, z, y])

function extractModelData(igz) {
    const igModelDrawCallData = igz.objects.filter(e => e.type === 'igModelDrawCallData')

    if (igModelDrawCallData == null || igModelDrawCallData.length == 0) 
        return console.warn('No draw call data for ' + igz.path)

    const animatedTransform = igModelDrawCallData[0].references.find(e => e.type === 'igAnimatedTransform')
    const transforms = animatedTransform ? igz.objects.filter(e => e.type == 'igAnimatedTransform').map(e => convertPosition(e.view.readVector(3, 0x50))) : null
    // if (animatedTransform != null) console.warn('Animated model: ' + igz.path)

    function processDrawCall(drawCall) {
        const igGraphicsVertexBuffer = drawCall.getChild('igGraphicsVertexBuffer')
        const igVertexBuffer = igGraphicsVertexBuffer.getChild('igVertexBuffer')
        const vertexData = extractVertexData(igVertexBuffer, null)
    
        const igGraphicsIndexBuffer  = drawCall.getChild('igGraphicsIndexBuffer')
        const igIndexBuffer = igGraphicsIndexBuffer.getChild('igIndexBuffer')
        const indexData = extractVertexData(igIndexBuffer, 2)
    
        return { vertexData, indexData }
    }
    
    function extractVertexData(igBuffer, elementSize) {
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
                data.push({ position: convertPosition(position), normal: [0, 0, 0], uv })
            }
            else {
                const position = dataObject.view.readVector(3)
                const normal   = dataObject.view.readVector(3)
                if (hasPadding)  dataObject.view.skip(4)
                const uv = dataObject.view.readVectorHalf(2)
                data.push({ position: convertPosition(position), normal: convertPosition(normal), uv })
            }
        }
    
        return data
    }

    const drawCalls = igModelDrawCallData.map(processDrawCall)
    return {drawCalls, transforms}
}

export { 
    extractModelData,
}