class ObjectField {
    constructor(...props) {
        Object.assign(this, ...props)
    }

    isVectorType(type) {
        type ??= this.type
        return type.startsWith('igVec') && type.endsWith('fMetaField')
    }

    isArrayType(type) {
        type ??= this.type
        return this.isVectorType(type) || [
            'igVectorMetaField', 
            'igFloatArrayMetaField',
            'igMatrix44fMetaField',
            'igQuaternionfMetaField'
        ].includes(type)
    }

    isStringType(type) {
        type ??= this.type
        return type === 'igStringMetaField' || type === 'igNameMetaField'
    }

    isIntegerType(type) {
        return [
            'igIntMetaField',
            'igUnsignedIntMetaField',
            'igShortMetaField',
            'igUnsignedShortMetaField',
            'igCharMetaField',
            'igUnsignedCharMetaField',
        ].includes(type ?? this.type)
    }

    getColorClass() {
        if (this.bitfieldRoot) return null

        const type = this.metaField ?? this.type
        if (type == 'igBoolMetaField')      return 'hex-bool'
        if (type == 'igEnumMetaField')      return 'hex-enum'
        if (type == 'igFloatMetaField')     return 'hex-float'
        if (type == 'igObjectRefMetaField') return 'hex-child'
        if (this.isStringType(type))        return 'hex-string'
        if (this.isVectorType(type))        return 'hex-vec'
        if (this.isArrayType(type))         return 'hex-array'
        if (this.isIntegerType(type))       return 'hex-int'
    }

    getPrettyType(type) {
        type ??= this.metaObject ?? this.metaField ?? this.type

        // Remove 'ig' and 'MetaField'
        if (type.startsWith('ig')) type = type.slice(2)
        if (type.endsWith('MetaField')) type = type.slice(0, -9)

        // Add bit count
        if (this.bitfield && this.metaField !== 'igBoolMetaField') type += ` (${this.bits})`
        if (this.type == 'igVectorMetaField') type += ` (${this.size / 4})`

        // Add space between camel case
        if (!this.metaObject) type = type.replace(/(?<=[a-z])(?=[A-Z][a-z])/g, ' ')

        return type
    }
}

export default ObjectField