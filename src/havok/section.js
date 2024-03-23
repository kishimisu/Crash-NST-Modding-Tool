const LOCAL_FIXUP_SIZE   = 2 * 4
const GLOBAL_FIXUP_SIZE  = 3 * 4
const VIRTUAL_FIXUP_SIZE = 3 * 4

class HavokSection {
    constructor(index) {
        this.index = index

        this.name = null
        this.size = null
        this.dataOffset = null

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

    toString() {
        return {
            localFixups: this.localFixups.length,
            globalFixups: this.globalFixups.length,
            virtualFixups: this.virtualFixups.length
        }
    }

    toNodeTree() {
        return {
            text: `${this.name} (start: ${this.dataOffset}, size: ${this.size})`,
            children: this.localFixups.length == 0 && this.globalFixups.length == 0 && this.virtualFixups.length == 0 ? null :
            [
                {
                text: `Local fixups (${this.localFixups.length})`,
                children: this.localFixups.length == 0 ? null : this.localFixups.map(fixup => ({
                    text: `Pointer: ${fixup.pointer}, Destination: ${fixup.destination}`
                }))
            },
            {
                text: `Global fixups (${this.globalFixups.length})`,
                children: this.globalFixups.length == 0 ? null : this.globalFixups.map(fixup => ({
                    text: `Pointer: ${fixup.pointer}, Section ID: ${fixup.sectionId}, Destination: ${fixup.destination}`
                }))
            },
            {
                text: `Virtual fixups (${this.virtualFixups.length})`,
                children: this.virtualFixups.length == 0 ? null : this.virtualFixups.map(fixup => ({
                    text: `Pointer: ${fixup.pointer}, Section ID: ${fixup.sectionId}, Class name offset: ${fixup.classNameOffset}`
                }))
            }]
        }
    }
}

export default HavokSection