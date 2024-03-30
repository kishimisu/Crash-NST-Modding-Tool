const LOCAL_FIXUP_SIZE   = 2 * 4
const GLOBAL_FIXUP_SIZE  = 3 * 4
const VIRTUAL_FIXUP_SIZE = 3 * 4

class HavokSection {
    constructor(index) {
        this.index = index

        this.name = null
        this.size = null
        this.dataOffset = null
        this.fixupOffset = null

        this.localFixups = []
        this.globalFixups = []
        this.virtualFixups = []
    }

    static fromBuffer(reader, index) {
        const section = new HavokSection(index)
        section.initialize(reader)
        return section
    }

    initialize(reader) {
        // Read header
        const sectionTag = reader.readChars(20).split('\0')[0]
        const dataOffset = reader.readUInt()
        
        // Read fixup start offsets
        const localFixupOffset    = reader.readUInt()
        const globalFixupsOffset  = reader.readUInt()
        const virtualFixupsOffset = reader.readUInt()
        const exportsOffset       = reader.readUInt()
        const importsOffset       = reader.readUInt()
        const bufferSize          = reader.readUInt()

        this.name = sectionTag
        this.size = bufferSize
        this.dataOffset = dataOffset
        this.fixupOffset = localFixupOffset

        // Calculate fixup count
        const virtualEOF = (exportsOffset == 0xFFFFFFFF ? importsOffset : exportsOffset)
        const numLocalFixups   = Math.floor((globalFixupsOffset - localFixupOffset) / LOCAL_FIXUP_SIZE)
        const numGlobalFixups  = Math.floor((virtualFixupsOffset - globalFixupsOffset) / GLOBAL_FIXUP_SIZE)
        const numVirtualFixups = Math.floor((virtualEOF - virtualFixupsOffset) / VIRTUAL_FIXUP_SIZE)
        
        // Read fixups
        reader.seek(dataOffset + localFixupOffset)
        for (let i = 0; i < numLocalFixups; i++) {
            const pointer = reader.readInt()
            const destination = reader.readInt()
            this.localFixups.push({ pointer, destination })
        }

        reader.seek(dataOffset + globalFixupsOffset)
        for (let i = 0; i < numGlobalFixups; i++) {
            const pointer = reader.readInt()
            const sectionId = reader.readInt()
            const destination = reader.readInt()
            this.globalFixups.push({ pointer, sectionId, destination })
        }

        reader.seek(dataOffset + virtualFixupsOffset)
        for (let i = 0; i < numVirtualFixups; i++) {
            const pointer = reader.readInt()
            const sectionId = reader.readInt()
            const classNameOffset = reader.readInt()
            this.virtualFixups.push({ pointer, sectionId, classNameOffset })
        }
    }

    save(writer) {
        // Write header
        writer.setChars(this.name)
        writer.skip(20 - this.name.length)
        writer.setUInt(this.dataOffset)

        const localFixupSize = this.localFixups.length * LOCAL_FIXUP_SIZE
        const globalFixupSize = this.globalFixups.length * GLOBAL_FIXUP_SIZE
        const virtualFixupSize = this.virtualFixups.length * VIRTUAL_FIXUP_SIZE
       
        const localFixupOffset = this.fixupOffset
        const globalFixupOffset = localFixupOffset + localFixupSize
        const virtualFixupOffset = globalFixupOffset + globalFixupSize
        const virtualEOF = virtualFixupOffset + virtualFixupSize

        // Write fixup start offsets
        writer.setUInt(localFixupOffset)
        writer.setUInt(globalFixupOffset)
        writer.setUInt(virtualFixupOffset)
        writer.setUInt(virtualEOF)
        writer.setUInt(virtualEOF)
        writer.setUInt(virtualEOF)

        writer.align(16)
        writer.setBytes(new Uint8Array(16).fill(0xFF))
        const headerEndOffset = writer.offset

        // Write fixups
        writer.seek(this.dataOffset + localFixupOffset)
        for (const fixup of this.localFixups) {
            writer.setInt(fixup.pointer)
            writer.setInt(fixup.destination)
        }

        writer.seek(this.dataOffset + globalFixupOffset)
        for (const fixup of this.globalFixups) {
            writer.setInt(fixup.pointer)
            writer.setInt(fixup.sectionId)
            writer.setInt(fixup.destination)
        }

        writer.seek(this.dataOffset + virtualFixupOffset)
        for (const fixup of this.virtualFixups) {
            writer.setInt(fixup.pointer)
            writer.setInt(fixup.sectionId)
            writer.setInt(fixup.classNameOffset)
        }

        writer.seek(headerEndOffset)
    }

    calculateEOF() {
        return this.fixupOffset + 
               this.virtualFixups.length * VIRTUAL_FIXUP_SIZE + 
               this.globalFixups.length * GLOBAL_FIXUP_SIZE + 
               this.localFixups.length * LOCAL_FIXUP_SIZE
    }

    getFixupsInRange(start, end) {
        const localFixups = this.localFixups.filter(e => e.pointer + this.dataOffset >= start && e.pointer + this.dataOffset < end)
        const globalFixups = this.globalFixups.filter(e => e.pointer + this.dataOffset >= start && e.pointer + this.dataOffset < end)
        const virtualFixups = this.virtualFixups.filter(e => e.pointer + this.dataOffset >= start && e.pointer + this.dataOffset < end)
        return { localFixups, globalFixups, virtualFixups }
    }

    findReferencedObject(hkx, pointer, showField = false) {
        const getName = (object) => `${object.type}${object.typeCount > 1 ? ` ${object.typeCount}` : ''}`

        const globalOffset = pointer + hkx.sections[2].dataOffset
        let object = hkx.objects.find(e => globalOffset >= e.offset && globalOffset < e.offset + e.size)
        object ??= hkx.objects.find(e => globalOffset >= e.offset && globalOffset < e.offset + e.rootSize)
        if (object == null) return '<Not found>'

        const relativeOffset = globalOffset - object.offset
        if (relativeOffset == 0 && !showField) return getName(object)

        if (relativeOffset >= object.size) return `${getName(object)}::0x${relativeOffset.toString(16)}`

        const field = object.fields.find(e => e.offset == relativeOffset)
        if (field == null) return `${getName(object)}::<Error>`

        return `${getName(object)}::${field.name}`
    }

    toString() {
        return {
            localFixups: this.localFixups.length,
            globalFixups: this.globalFixups.length,
            virtualFixups: this.virtualFixups.length
        }
    }

    toNodeTree(hkx) {
        return {
            text: `${this.name} (start: ${this.dataOffset}, size: ${this.size})`,
            children: this.localFixups.length == 0 && this.globalFixups.length == 0 && this.virtualFixups.length == 0 ? null :
            [
                {
                text: `Local fixups (${this.localFixups.length})`,
                children: this.localFixups.length == 0 ? null : this.localFixups.slice(0, -1).map((fixup, index) => ({
                    text: `${index}: ${this.findReferencedObject(hkx, fixup.pointer, true)} => ${this.findReferencedObject(hkx, fixup.destination)}`
                }))
            },
            {
                text: `Global fixups (${this.globalFixups.length})`,
                children: this.globalFixups.length == 0 ? null : this.globalFixups.slice(0, -1).map((fixup, index) => ({
                    text: `${index}: ${this.findReferencedObject(hkx, fixup.pointer, true)} => ${this.findReferencedObject(hkx, fixup.destination)}`
                }))
            },
            {
                text: `Virtual fixups (${this.virtualFixups.length})`,
                children: this.virtualFixups.length == 0 ? null : this.virtualFixups.slice(0, -1).map((fixup, index) => ({
                    text: `${index}: ${this.findReferencedObject(hkx, fixup.pointer)}`
                }))
            }]
        }
    }
}

export default HavokSection