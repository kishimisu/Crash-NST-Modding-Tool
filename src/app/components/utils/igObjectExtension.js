import igObject from "../../../igz/igObject"
import { computeHash } from "../../../utils"
import * as dxt from 'dxt-js'

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
    const rotation = this.view.readVector(3, 0x60)
    const scale = this.view.readVector(3, 0x70)

    return { rotation, scale }
}

igObject.prototype.getModel = function(igz) {
    let model_offset = this.type == 'CActorData' ? 0x98 : this.type == 'CModelComponentData' ? 0x18 : 0x48
    
    const hasModel = this.fixups.RSTT.includes(model_offset)
    const hasSkin  = this.fixups.RSTT.includes(model_offset + 8)
    
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

    // Special case: collectibles
    if (this.name.includes('Collectible_Wumpa'))
        return "crash_wumpafruit_no_sparkles"
    else if (this.name.includes('Collectible_ExtraLife'))
        return "Collectible_Crash_ExtraLife"
    
    return null
}

const convertVector = (v) => [-v[0], v[2], v[1]]

igObject.prototype.toMeshInfo = function(igz, { color = 0xffffff, transform = {}, ...props } = {}) {
    const positionOffset = this.type == 'CWaypoint' ? 0x14 : 0x20
    const position = this.size <= 44 ? [0, 0, 0] : this.view.readVector(3, positionOffset)
    
    const info = {
        igz: igz.path,
        name: this.name,
        objectIndex: this.index,
        position,
        objectHash: this.original_name_hash ?? computeHash(this.name),
        type: this.type,
        color,
        ...transform,
        ...props
    }

    info.position = convertVector(info.position)
    if (info.scale) info.scale = [info.scale[0], info.scale[2], info.scale[1]]
    if (info.rotation) info.rotation = convertVector(info.rotation)
    if (info.parentPosition) info.parentPosition = convertVector(info.parentPosition)

    return info
}

igObject.prototype.extractMemoryData = function(igz, offset, elementSize = 4, method = 'UInt') {
    const data = []

    const memory_size = this.view.readUInt(offset)
    if (memory_size == 0) return { data, active: false }

    const bitfield = this.view.readUInt(offset + 4)
    const active = ((bitfield >> 0x18) & 0x1) != 0x0
    if (!active) return { data, active: false }

    const dataOffset = this.view.readUInt(offset + 8)
    const elementCount = memory_size / elementSize
    const object = igz.findObject(dataOffset)
    const startOffset = igz.getGlobalOffset(dataOffset) - object.global_offset

    for (let i = 0; i < elementCount; i++) {
        const offset = startOffset + i * elementSize
        const value  = object.view['read' + method](offset)
        data.push(value)
    }

    return {
        data, 
        active,
        parent: object,
        relative_offset: startOffset,
        memory_size
    }
}

igObject.prototype.extractCollisionData = function(igz) {
    const data = this.extractMemoryData(igz, 0x20).data
    const values = this.extractMemoryData(igz, 0x10, 2, 'Int16').data

    const items = []
    for (let i = 0; i < data.length; i += 2) {
        const objectHash = data[i]
        const namespaceHash = data[i + 1]
        if (objectHash == 0xFAFAFAFA || namespaceHash == 0xFAFAFAFA) continue

        items.push({
            objectHash,
            namespaceHash,
            value: values[i / 2]
        })
    }

    return items
}

igObject.prototype.extractTexture = function(igz) {
    const format = igz.fixups.EXID.data[0][0]
    const width = this.view.readUInt16(0x18)
    const height = this.view.readUInt16(0x1A)

    const offset = 0x38
    const memory_size = this.view.readUInt(offset)
    if (memory_size == 0) return { data, active: false }

    const bitfield = this.view.readUInt(offset + 4)
    const active = ((bitfield >> 0x18) & 0x1) != 0x0
    if (!active) return { data, active: false }

    const dataOffset = this.view.readUInt(offset + 8)
    const object = igz.findObject(dataOffset)
    const startOffset = igz.getGlobalOffset(dataOffset) - object.global_offset

    const compressed = object.view.buffer.slice(startOffset, startOffset + memory_size)
    let pixels

    if (format.startsWith('dxt')) {
        const dxt_format = format == 'dxt1_dx11' ? dxt.flags.DXT1 : dxt.flags.DXT5
        pixels = dxt.decompress(compressed, width, height, dxt_format)
    }
    else if (format == 'r8g8b8a8_dx11') {
        pixels = new Uint8Array(compressed)
    }
    else {
        throw new Error(`Unsupported texture format ${format}`)
    }

    return { pixels, width, height }
}
