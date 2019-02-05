const Promise = require(`bluebird`)
const {
  GraphQLObjectType,
  GraphQLList,
  GraphQLBoolean,
  GraphQLString,
  GraphQLInt,
  GraphQLFloat,
} = require(`gatsby/graphql`)
const { queueImageResizing, base64 } = require(`gatsby-plugin-sharp`)

const sharp = require(`sharp`)

const DEFAULT_PNG_COMPRESSION_SPEED = 4

const {
  ImageFormatType,
  ImageCropFocusType,
  DuotoneGradientType,
  PotraceType,
} = require(`./types`)

const fixedNodeType = ({
  type,
  pathPrefix,
  getNodeAndSavePathDependency,
  reporter,
  workerApi,
  name,
  cache,
}) => {
  const fixed = ({ file, args }) =>
    workerApi.exec(require.resolve(`./worker`), `fixed`, null, {
      file,
      args,
    })

  const getTracedSVG = parent =>
    workerApi.exec(require.resolve(`./worker`), `getTracedSVG`, null, parent)

  return {
    type: new GraphQLObjectType({
      name: name,
      fields: {
        base64: { type: GraphQLString },
        tracedSVG: {
          type: GraphQLString,
          resolve: getTracedSVG,
        },
        aspectRatio: { type: GraphQLFloat },
        width: { type: GraphQLFloat },
        height: { type: GraphQLFloat },
        src: { type: GraphQLString },
        srcSet: { type: GraphQLString },
        srcWebp: {
          type: GraphQLString,
          resolve: async ({ file, image, fieldArgs }) => {
            // If the file is already in webp format or should explicitly
            // be converted to webp, we do not create additional webp files
            if (file.extension === `webp` || fieldArgs.toFormat === `webp`) {
              return null
            }
            const args = { ...fieldArgs, pathPrefix, toFormat: `webp` }
            return await fixed({ file, args }).src
          },
        },
        srcSetWebp: {
          type: GraphQLString,
          resolve: async ({ file, image, fieldArgs }) => {
            // If the file is already in webp format or should explicitly
            // be converted to webp, we do not create additional webp files
            if (file.extension === `webp` || fieldArgs.toFormat === `webp`) {
              return null
            }
            const args = { ...fieldArgs, pathPrefix, toFormat: `webp` }
            return await fixed({ file, args }).srcSet
          },
        },
        originalName: { type: GraphQLString },
      },
    }),
    args: {
      width: {
        type: GraphQLInt,
      },
      height: {
        type: GraphQLInt,
      },
      jpegProgressive: {
        type: GraphQLBoolean,
        defaultValue: true,
      },
      pngCompressionSpeed: {
        type: GraphQLInt,
        defaultValue: DEFAULT_PNG_COMPRESSION_SPEED,
      },
      grayscale: {
        type: GraphQLBoolean,
        defaultValue: false,
      },
      duotone: {
        type: DuotoneGradientType,
        defaultValue: false,
      },
      traceSVG: {
        type: PotraceType,
        defaultValue: false,
      },
      quality: {
        type: GraphQLInt,
        defaultValue: 50,
      },
      toFormat: {
        type: ImageFormatType,
        defaultValue: ``,
      },
      cropFocus: {
        type: ImageCropFocusType,
        defaultValue: sharp.strategy.attention,
      },
      rotate: {
        type: GraphQLInt,
        defaultValue: 0,
      },
    },
    resolve: async (image, fieldArgs, context) => {
      const file = getNodeAndSavePathDependency(image.parent, context.path)
      const args = { ...fieldArgs, pathPrefix }
      const result = await fixed({ file, args })
      return {
        fieldArgs: args,
        image,
        file,
        ...result,
      }
    },
  }
}

const fluidNodeType = ({
  type,
  pathPrefix,
  getNodeAndSavePathDependency,
  reporter,
  name,
  workerApi,
  cache,
}) => {
  const getTracedSVG = parent =>
    workerApi.exec(require.resolve(`./worker`), `getTracedSVG`, null, parent)

  const fluid = (file, args) =>
    workerApi.exec(require.resolve(`./worker`), `fluid`, null, { file, args })

  return {
    type: new GraphQLObjectType({
      name: name,
      fields: {
        base64: { type: GraphQLString },
        tracedSVG: {
          type: GraphQLString,
          resolve: getTracedSVG,
        },
        aspectRatio: { type: GraphQLFloat },
        src: { type: GraphQLString },
        srcSet: { type: GraphQLString },
        srcWebp: {
          type: GraphQLString,
          resolve: async ({ file, image, fieldArgs }) => {
            if (image.extension === `webp` || fieldArgs.toFormat === `webp`) {
              return null
            }
            const args = { ...fieldArgs, pathPrefix, toFormat: `webp` }
            return await fluid(file, args).src
          },
        },
        srcSetWebp: {
          type: GraphQLString,
          resolve: async ({ file, image, fieldArgs }) => {
            if (image.extension === `webp` || fieldArgs.toFormat === `webp`) {
              return null
            }
            const args = { ...fieldArgs, pathPrefix, toFormat: `webp` }
            return await fluid(file, args).srcSet
          },
        },
        sizes: { type: GraphQLString },
        originalImg: { type: GraphQLString },
        originalName: { type: GraphQLString },
        presentationWidth: { type: GraphQLInt },
        presentationHeight: { type: GraphQLInt },
      },
    }),
    args: {
      maxWidth: {
        type: GraphQLInt,
      },
      maxHeight: {
        type: GraphQLInt,
      },
      grayscale: {
        type: GraphQLBoolean,
        defaultValue: false,
      },
      jpegProgressive: {
        type: GraphQLBoolean,
        defaultValue: true,
      },
      pngCompressionSpeed: {
        type: GraphQLInt,
        defaultValue: DEFAULT_PNG_COMPRESSION_SPEED,
      },
      duotone: {
        type: DuotoneGradientType,
        defaultValue: false,
      },
      traceSVG: {
        type: PotraceType,
        defaultValue: false,
      },
      quality: {
        type: GraphQLInt,
        defaultValue: 50,
      },
      toFormat: {
        type: ImageFormatType,
        defaultValue: ``,
      },
      cropFocus: {
        type: ImageCropFocusType,
        defaultValue: sharp.strategy.attention,
      },
      rotate: {
        type: GraphQLInt,
        defaultValue: 0,
      },
      sizes: {
        type: GraphQLString,
        defaultValue: ``,
      },
      srcSetBreakpoints: {
        type: GraphQLList(GraphQLInt),
        defaultValue: [],
        description: `A list of image widths to be generated. Example: [ 200, 340, 520, 890 ]`,
      },
    },
    resolve: async (image, fieldArgs, context) => {
      const file = getNodeAndSavePathDependency(image.parent, context.path)
      const args = { ...fieldArgs, pathPrefix }
      const result = await fluid(file, args)
      return {
        ...result,
        fieldArgs: args,
        image,
        file,
      }
    },
  }
}

module.exports = ({
  type,
  pathPrefix,
  getNodeAndSavePathDependency,
  reporter,
  workerApi,
  cache,
}) => {
  if (type.name !== `ImageSharp`) {
    return {}
  }

  const getTracedSVG = parent =>
    workerApi.exec(require.resolve(`./worker`), `getTracedSVG`, null, parent)

  const nodeOptions = {
    type,
    pathPrefix,
    getNodeAndSavePathDependency,
    reporter,
    workerApi,
    cache,
  }

  // TODO: Remove resolutionsNode and sizesNode for Gatsby v3
  const fixedNode = fixedNodeType({ name: `ImageSharpFixed`, ...nodeOptions })
  const resolutionsNode = fixedNodeType({
    name: `ImageSharpResolutions`,
    ...nodeOptions,
  })
  resolutionsNode.deprecationReason = `Resolutions was deprecated in Gatsby v2. It's been renamed to "fixed" https://example.com/write-docs-and-fix-this-example-link`

  const fluidNode = fluidNodeType({ name: `ImageSharpFluid`, ...nodeOptions })
  const sizesNode = fluidNodeType({ name: `ImageSharpSizes`, ...nodeOptions })
  sizesNode.deprecationReason = `Sizes was deprecated in Gatsby v2. It's been renamed to "fluid" https://example.com/write-docs-and-fix-this-example-link`

  return {
    fixed: fixedNode,
    resolutions: resolutionsNode,
    fluid: fluidNode,
    sizes: sizesNode,
    original: {
      type: new GraphQLObjectType({
        name: `ImageSharpOriginal`,
        fields: {
          width: { type: GraphQLFloat },
          height: { type: GraphQLFloat },
          src: { type: GraphQLString },
        },
      }),
      args: {},
      async resolve(image, fieldArgs, context) {
        const details = getNodeAndSavePathDependency(image.parent, context.path)
        return await workerApi.exec(
          require.resolve(`./worker`),
          `original`,
          null,
          image,
          details
        )
      },
    },
    resize: {
      type: new GraphQLObjectType({
        name: `ImageSharpResize`,
        fields: {
          src: { type: GraphQLString },
          tracedSVG: {
            type: GraphQLString,
            resolve: getTracedSVG,
          },
          width: { type: GraphQLInt },
          height: { type: GraphQLInt },
          aspectRatio: { type: GraphQLFloat },
          originalName: { type: GraphQLString },
        },
      }),
      args: {
        width: {
          type: GraphQLInt,
        },
        height: {
          type: GraphQLInt,
        },
        quality: {
          type: GraphQLInt,
          defaultValue: 50,
        },
        jpegProgressive: {
          type: GraphQLBoolean,
          defaultValue: true,
        },
        pngCompressionLevel: {
          type: GraphQLInt,
          defaultValue: 9,
        },
        pngCompressionSpeed: {
          type: GraphQLInt,
          defaultValue: DEFAULT_PNG_COMPRESSION_SPEED,
        },
        grayscale: {
          type: GraphQLBoolean,
          defaultValue: false,
        },
        duotone: {
          type: DuotoneGradientType,
          defaultValue: false,
        },
        base64: {
          type: GraphQLBoolean,
          defaultValue: false,
        },
        traceSVG: {
          type: PotraceType,
          defaultValue: false,
        },
        toFormat: {
          type: ImageFormatType,
          defaultValue: ``,
        },
        cropFocus: {
          type: ImageCropFocusType,
          defaultValue: sharp.strategy.attention,
        },
        rotate: {
          type: GraphQLInt,
          defaultValue: 0,
        },
      },
      resolve: (image, fieldArgs, context) => {
        const file = getNodeAndSavePathDependency(image.parent, context.path)
        const args = { ...fieldArgs, pathPrefix }
        return new Promise(resolve => {
          if (fieldArgs.base64) {
            resolve(
              base64({
                file,
                cache,
              })
            )
          } else {
            const o = queueImageResizing({
              file,
              args,
            })
            resolve(
              Object.assign({}, o, {
                image,
                file,
                fieldArgs: args,
              })
            )
          }
        })
      },
    },
  }
}
