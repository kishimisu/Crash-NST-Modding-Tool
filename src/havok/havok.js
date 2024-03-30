import { writeFileSync } from "fs"
import { BufferView } from "../utils"
import HavokSection from "./section"
import hkObject, { HAVOK_METADATA } from "./hkObject"

const SIGNATURE = 0x10C0C01057E0E057n

class HavokFile {
    constructor(data, path) {
        this.path = path
        this.sections = []
        this.dataSection = null // => this.sections[2]
        this.objects = []

        this.reader = null
        this.header = null
        this.objectsBuffer = null

        this.initialize(new Uint8Array(data))
    }

    static fromFileInfos(file) {
        const data = file.getUncompressedData()
        return new HavokFile(data, file.path)
    }

    initialize(buffer) {
        const reader = new BufferView(buffer)
        this.reader = reader

        /// Read Header ///

        const signature = reader.readULong()
        const userTag   = reader.readUInt()
        const version   = reader.readUInt()

        const ptrSize                    = reader.readUInt8()
        const littleEndian               = reader.readUInt8()
        const reusePaddingOptimization   = reader.readUInt8()
        const emptyBaseClassOptimization = reader.readUInt8()
        
        const numSections = reader.readInt()
        const contentSectionIndex  = reader.readInt()
        const contentSectionOffset = reader.readInt()
        const contentsClassNameSectionIndex  = reader.readInt()
        const contentsClassNameSectionOffset = reader.readInt()

        const contentsVersion = reader.readChars(16).split('\0')[0]

        const flags = reader.readUInt()
        const maxPredicate = reader.readInt16()
        const predicateArraySizePlusPadding = reader.readInt16()

        if (signature != SIGNATURE) throw new Error('Invalid Havok file signature', signature.toString(16))
        if (version != 11) throw new Error('Havok file version is not 11')

        if (maxPredicate != -1) reader.skip(predicateArraySizePlusPadding)

        /// Read Sections ///

        let nextOffset = reader.offset

        for (let i = 0; i < numSections; i++) {
            reader.seek(nextOffset)
            const section = HavokSection.fromBuffer(reader, i)
            this.sections.push(section)
            nextOffset += 64
        }

        /// Store Useful Data ///

        this.dataSection = this.sections[2]
        this.header = buffer.slice(0, nextOffset)
        this.objectsBuffer = buffer.slice(this.dataSection.dataOffset, this.dataSection.dataOffset + this.dataSection.fixupOffset)

        /// Initialize Fixups ///

        for (let i = 0; i < numSections; i++) {
            const section = this.sections[i]

            // Fix-up the fix-ups
            for (const lf of section.localFixups) {
                if (lf.pointer == -1) continue
                reader.setUInt(section.dataOffset + lf.destination, section.dataOffset + lf.pointer)
            }
            for (const gf of section.globalFixups) {
                if (gf.pointer == -1) continue
                reader.setUInt(this.sections[gf.sectionId].dataOffset + gf.destination, section.dataOffset + gf.pointer)
            }

            // Read root objects names and offsets
            for (const vf of section.virtualFixups) {
                if (vf.pointer == -1) continue
                const name = reader.readStr(this.sections[vf.sectionId].dataOffset + vf.classNameOffset)
                // const uuid = reader.readUInt(section.dataOffset + vf.classNameOffset - 4)
                vf.name = name
                vf.globalOffset = section.dataOffset + vf.pointer
            }
        }

        /// Create objects ///

        const virtualFixups = this.dataSection.virtualFixups.filter(e => e.pointer != -1)

        for (let i = 0; i < virtualFixups.length; i++) {
            const fixupData = virtualFixups[i]
            const object = new hkObject(fixupData.name, fixupData.globalOffset, true)
            this.objects.push(object)
        }

        this.objects.forEach((e, i) => e.rootSize = (this.objects[i + 1]?.offset ?? buffer.length) - e.offset)
        this.objects.forEach(object => object.initialize(this))
        this.objects.forEach((e, i) => e.index = i)

        /// Add index for classes that appear more than once ///

        let objectsTypeCount = {}
        this.objects.forEach(e => objectsTypeCount[e.type] = (objectsTypeCount[e.type] || 0) + (e.name == '' ? 1 : 0))

        const multipleOccurences = this.objects.filter(e => objectsTypeCount[e.type] > 1)
        objectsTypeCount = {}

        multipleOccurences.forEach(e => {
            e.typeCount = (objectsTypeCount[e.type] || 0) + 1
            objectsTypeCount[e.type] = e.typeCount
        })
    }

    save(filePath) {
        const sizeApprox = this.dataSection.dataOffset + this.dataSection.calculateEOF() + 2000
        const buffer = new Uint8Array(sizeApprox)
        const writer = new BufferView(buffer)

        // Write header
        buffer.set(this.header)
        writer.seek(this.header.byteLength)

        // Get class names
        const classes = [
            // Mandatory classes
            { name: 'hkClass',         id: 0x33d42383 },
            { name: 'hkClassMember',   id: 0xb0efa719 }, 
            { name: 'hkClassEnum',     id: 0x8a3609cf },
            { name: 'hkClassEnumItem', id: 0xce6f8a6c },

            // Root objects classes
            ...this.objects.filter(e => e.root).map(e => ({ 
                name: e.type, 
                id: HAVOK_METADATA.types[e.type].id 
            }))
        ]

        // Write class names
        classes.forEach(e => {
            writer.setUInt(e.id)
            writer.setByte(0x09)
            e.offset = writer.offset - 272
            writer.setChars(e.name)
            writer.setByte(0x00)
        })
        writer.align(16)

        // Update data start offset
        this.dataSection.dataOffset = writer.offset

        this.dataSection.virtualFixups.forEach(e => {
            if (e.pointer == -1) return
            e.classNameOffset = classes.find(c => c.name == e.name).offset
        })

        // Write data section
        writer.seek(this.header.byteLength - 64)
        this.dataSection.save(writer)

        // Write objects
        buffer.set(this.objectsBuffer, this.dataSection.dataOffset)

        // Resize final buffer
        const finalSize = this.dataSection.dataOffset + this.dataSection.calculateEOF()
        const finalData = buffer.slice(0, finalSize)

        if (filePath) {
            writeFileSync(filePath, finalData)
        }

        return finalData
    }

    /**
     *  Get the object at the specified offset.
     *  If the object does not exist, it will be created.
     */
    getObject(type, offset) {
        if (offset == 0) return null

        let object = this.objects.find(e => e.offset == offset)
        
        if (!object) {
            object = new hkObject(type, offset)
            object.initialize(this)
            this.objects.push(object)
        }

        return object
    }

    toNodeTree(recursive = false, mode = 'root') {
        let root = [ this.objects[0] ]

        if (mode == 'all') root = this.objects
        else if (mode == 'named') root = this.objects.filter(e => e.name != '')
        else if (mode == 'alchemist') root = this.objects.filter(e => e.root)

        return [
            {
                text: '[Sections]',
                children: this.sections.map(e => e.toNodeTree(this))
            },
            ...root.map(e => e.toNodeTree())
        ]
    }

    toString() {
        return {
            sections: this.sections.map(e => e.toString()),
            objects: this.objects.map(e => e.getName())
        }
    }
}

export default HavokFile