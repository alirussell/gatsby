const _ = require(`lodash`)
const prepareRegex = require(`../../utils/prepare-regex`)
const { getNodeTypeCollection } = require(`./nodes`)
const sift = require(`sift`)

const siftifyArgs = object => {
  const newObject = {}
  _.each(object, (v, k) => {
    if (_.isPlainObject(v)) {
      if (k === `elemMatch`) {
        k = `$elemMatch`
      }
      newObject[k] = siftifyArgs(v)
    } else {
      // Compile regex first.
      if (k === `regex`) {
        newObject[`$regex`] = prepareRegex(v)
      } else if (k === `glob`) {
        const Minimatch = require(`minimatch`).Minimatch
        const mm = new Minimatch(v)
        newObject[`$regex`] = mm.makeRe()
      } else {
        newObject[`$${k}`] = v
      }
    }
  })
  return newObject
}

function runSift(nodes, query) {
  if (nodes) {
    const siftQuery = {
      $elemMatch: siftifyArgs(query),
    }
    return sift(siftQuery, nodes)
  } else {
    return null
  }
}

// Takes a raw graphql filter and converts it into a mongo-like args
// object. E.g `eq` becomes `$eq`. gqlFilter should be the raw graphql
// filter returned from graphql-js. e.g:
//
// {
//   internal: {
//     type: {
//       eq: "TestNode"
//     },
//     content: {
//       glob: "et"
//     }
//   },
//   id: {
//     glob: "12*"
//   }
// }
//
// would return
//
// {
//   internal: {
//     type: {
//       $eq: "TestNode"  // append $ to eq
//     },
//     content: {
//       $regex: new MiniMatch(v) // convert glob to regex
//     }
//   },
//   id: {
//     $regex: // as above
//   }
// }
function toMongoArgs(gqlFilter, gqlFields, lastField) {
  const mongoArgs = {}
  _.each(gqlFilter, (v, k) => {
    if (_.isPlainObject(v)) {
      const gqlField = gqlFields[k]
      if (k === `elemMatch`) {
        mongoArgs[`$where`] = obj => {
          const result = runSift(obj, v)
          return result && result.length > 0
        }
      } else {
        mongoArgs[k] = toMongoArgs(v, gqlFields, gqlField)
      }
    } else {
      // Compile regex first.
      if (k === `regex`) {
        mongoArgs[`$regex`] = prepareRegex(v)
      } else if (k === `glob`) {
        const Minimatch = require(`minimatch`).Minimatch
        const mm = new Minimatch(v)
        mongoArgs[`$regex`] = mm.makeRe()
      } else if (
        k === `in` &&
        lastField &&
        lastField.type &&
        lastField.type.constructor.name === `GraphQLList`
      ) {
        mongoArgs[`$containsAny`] = v
      } else if (
        k === `nin` &&
        lastField.type.constructor.name === `GraphQLList`
      ) {
        mongoArgs[`$containsNone`] = v
      } else if (k === `ne` && v === null) {
        mongoArgs[`$ne`] = undefined
      } else {
        mongoArgs[`$${k}`] = v
      }
    }
  })
  return mongoArgs
}

// Converts a nested mongo args object into a dotted notation. acc
// (accumulator) must be a reference to an empty object. The converted
// fields will be added to it. E.g
//
// {
//   internal: {
//     type: {
//       $eq: "TestNode"
//     },
//     content: {
//       $regex: new MiniMatch(v)
//     }
//   },
//   id: {
//     $regex: newMiniMatch(v)
//   }
// }
//
// After execution, acc would be:
//
// {
//   "internal.type": {
//     $eq: "TestNode"
//   },
//   "internal.content": {
//     $regex: new MiniMatch(v)
//   },
//   "id": {
//     $regex: // as above
//   }
// }
function dotNestedFields(acc, o, path = ``) {
  if (_.isPlainObject(o)) {
    if (_.isPlainObject(_.sample(o))) {
      _.forEach(o, (v, k) => {
        dotNestedFields(acc, v, path + `.` + k)
      })
    } else {
      acc[_.trimStart(path, `.`)] = o
    }
  }
}

// Converts graphQL args to a loki query
function convertArgs(gqlArgs, gqlType) {
  const dottedFields = {}
  dotNestedFields(
    dottedFields,
    toMongoArgs(gqlArgs.filter, gqlType[`_typeConfig`].fields)
  )
  return dottedFields
}

// Converts graphql Sort args into the form expected by loki, which is
// a vector where the first value is a field name, and the second is a
// boolean `isDesc`. Nested fields delimited by `___` are replaced by
// periods. E.g
//
// {
//   fields: [ `frontmatter___date`, `id` ],
//   order: `desc`
// }
//
// would return
//
// [ [ `frontmatter.date`, true ], [ `id`, true ] ]
function toSortFields(sortArgs) {
  const { fields, order } = sortArgs
  return _.map(fields, field => [
    field.replace(/___/g, `.`),
    _.lowerCase(order) === `desc`,
  ])
}

// Ensure there is an index for each query field. If the index already
// exists, this is a noop (handled by lokijs).
function ensureIndexes(coll, findArgs) {
  _.forEach(findArgs, (v, fieldName) => {
    coll.ensureIndex(fieldName)
  })
}

/**
 * Runs the graphql query over the loki nodes db.
 *
 * @param {Object} args. Object with:
 *
 * {Object} gqlType: built during `./build-node-types.js`
 *
 * {Object} queryArgs: The raw graphql query as a js object. E.g `{
 * filter: { fields { slug: { eq: "/somepath" } } } }`
 *
 * {Object} context: The context from the QueryJob
 *
 * {boolean} firstOnly: Whether to return the first found match, or
 * all matching result.
 *
 * @returns {promise} A promise that will eventually be resolved with
 * a collection of matching objects (even if `firstOnly` is true)
 */
async function runQuery({ gqlType, queryArgs, context = {}, firstOnly }) {
  // Clone args as for some reason graphql-js removes the constructor
  // from nested objects which breaks a check in sift.js.
  const gqlArgs = JSON.parse(JSON.stringify(queryArgs))

  const lokiArgs = convertArgs(gqlArgs, gqlType)

  const coll = getNodeTypeCollection(gqlType.name)

  // Allow page creators to specify that they want indexes
  // automatically created for their pages.
  // if (context.useQueryIndex) {
  //   ensureIndexes(coll, lokiArgs)
  // }

  let chain = coll.chain().find(lokiArgs, firstOnly)

  const { sort } = gqlArgs
  if (sort) {
    const sortFields = toSortFields(sort)
    _.forEach(sortFields, ([fieldName]) => {
      coll.ensureIndex(fieldName)
    })
    chain = chain.compoundsort(sortFields)
  }

  return chain.data()
}

module.exports = runQuery
