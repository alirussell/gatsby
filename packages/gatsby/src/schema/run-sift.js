// @flow
const sift = require(`sift`)
const _ = require(`lodash`)
const { connectionFromArray } = require(`graphql-skip-limit`)
const { createPageDependency } = require(`../redux/actions/add-page-dependency`)
const prepareRegex = require(`./prepare-regex`)
const Promise = require(`bluebird`)
const { trackInlineObjectsInRootNode } = require(`./node-tracking`)
const { pluginFieldTracking } = require(`../redux`)
const { getNode, db } = require(`../db`)

const resolvedNodesCache = new Map()
const enhancedNodeCache = new Map()
const enhancedNodePromiseCache = new Map()
const enhancedNodeCacheId = ({ node, args }) =>
  node && node.internal && node.internal.contentDigest
    ? JSON.stringify({
        nodeid: node.id,
        digest: node.internal.contentDigest,
        ...args,
      })
    : null

function awaitSiftField(fields, node, k) {
  const field = fields[k]
  if (field.resolve) {
    return field.resolve(
      node,
      {},
      {},
      {
        fieldName: k,
      }
    )
  } else if (node[k] !== undefined) {
    return node[k]
  }

  return undefined
}

/////////////////////////////////////////////////////////////////////
// New Loki stuff
/////////////////////////////////////////////////////////////////////

function hasPluginFields(args) {
  const argFields = _.keys(args.filter)
  return _.some(argFields, field => pluginFieldTracking.has(field))
}

function toSortFields(sortArgs) {
  const { fields, order } = sortArgs
  return _(fields)
    .map(field => [field.replace(/___/g, `.`), sortArgs === `desc`])
    .values()
}

function _lokiArgsFlatten(o, path) {
  if (_.isPlainObject(o)) {
    if (_.isPlainObject(_.sample(o))) {
      return _.flatMap(o, (v, k) => {
        return _lokiArgsFlatten(v, path + `.` + k)
      })
    } else {
      return { [_.trimStart(path, `.`)]: o }
    }
  }
}

function lokiArgsFlatten(o) {
  const paths = _lokiArgsFlatten(o, ``)
  return _.reduce(paths, (acc, e) => _.merge(acc, e), {})
}

function createConnection(lokiResult, queryArgs) {
  const { skip, limit } = queryArgs
  const connectionArgs = {}
  if (skip && skip > 0) {
    connectionArgs.skip = 1
  }
  if (limit) {
    connectionArgs.limit = limit
  }
  return connectionFromArray(lokiResult, connectionArgs)
}

function execConnection(coll, mongoQuery, queryArgs, path) {
  const { sort, skip, limit } = queryArgs
  let chain = coll.chain()

  chain = chain.find(mongoQuery)

  if (sort) {
    chain = chain.compoundsort(toSortFields(sort))
  }

  if (skip && skip > 0) {
    chain = chain.offset(skip)
  }

  if (limit) {
    chain = chain.limit(limit + 1)
  }

  const lokiResult = chain.data()

  if (lokiResult.length === 0) return null

  const connection = createConnection(lokiResult, queryArgs)
  connection.totalCount = connection.edges.length

  if (connection.totalCount > 0) {
    createPageDependency({
      path,
      connection: connection.edges[0].node.internal.type,
    })
  }

  return connection
}

function execSingle(coll, mongoQuery, path) {
  const lokiResult = coll.findOne(mongoQuery)

  if (!lokiResult) return null

  createPageDependency({
    path,
    nodeId: lokiResult.id,
  })

  return lokiResult
}

/////////////////////////////////////////////////////////////////////
// End Loki stuff
/////////////////////////////////////////////////////////////////////

/*
 * Filters a list of nodes using mongodb-like syntax.
 * Returns a single unwrapped element if connection = false.
 *
 */
module.exports = ({
  args,
  nodes,
  type,
  typeName,
  connection = false,
  path = ``,
}: Object) => {
  // Clone args as for some reason graphql-js removes the constructor
  // from nested objects which breaks a check in sift.js.
  const clonedArgs = JSON.parse(JSON.stringify(args))

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
        } else if (k === `ne` && v === true) {
          newObject[`$where`] = a => a === undefined || a === false
        } else if (k === `ne` && v === null) {
          newObject[`$where`] = a => a !== undefined
        } else if (k === `in`) {
          newObject[`$contains`] = v
        } else {
          newObject[`$${k}`] = v
        }
      }
    })
    return newObject
  }

  // Build an object that excludes the innermost leafs,
  // this avoids including { eq: x } when resolving fields.
  function extractFieldsToSift(prekey, key, preobj, obj, val) {
    if (_.isPlainObject(val)) {
      _.forEach((val: any), (v, k) => {
        preobj[prekey] = obj
        extractFieldsToSift(key, k, obj, {}, v)
      })
    } else {
      preobj[prekey] = true
    }
  }

  const siftArgs = []
  const fieldsToSift = {}
  if (clonedArgs.filter) {
    _.each(clonedArgs.filter, (v, k) => {
      // Ignore connection and sorting args.
      if (_.includes([`skip`, `limit`, `sort`], k)) return

      siftArgs.push(
        siftifyArgs({
          [k]: v,
        })
      )
      extractFieldsToSift(``, k, {}, fieldsToSift, v)
    })
  }

  // Resolves every field used in the node.
  function resolveRecursive(node, siftFieldsObj, gqFields) {
    return Promise.all(
      _.keys(siftFieldsObj).map(k =>
        Promise.resolve(awaitSiftField(gqFields, node, k))
          .then(v => {
            const innerSift = siftFieldsObj[k]
            const innerGqConfig = gqFields[k]
            if (
              _.isObject(innerSift) &&
              v != null &&
              innerGqConfig &&
              innerGqConfig.type &&
              _.isFunction(innerGqConfig.type.getFields)
            ) {
              return resolveRecursive(
                v,
                innerSift,
                innerGqConfig.type.getFields()
              )
            } else {
              return v
            }
          })
          .then(v => [k, v])
      )
    ).then(resolvedFields => {
      const myNode = {
        ...node,
      }
      resolvedFields.forEach(([k, v]) => (myNode[k] = v))
      return myNode
    })
  }

  if (hasPluginFields(args)) {
    // If the the query only has a filter for an "id", then we'll just grab
    // that ID and return it.
    if (
      Object.keys(fieldsToSift).length === 1 &&
      Object.keys(fieldsToSift)[0] === `id`
    ) {
      const node = resolveRecursive(
        getNode(siftArgs[0].id[`$eq`]),
        fieldsToSift,
        type.getFields()
      )

      if (node) {
        createPageDependency({
          path,
          nodeId: node.id,
        })
      }

      return node
    }

    const nodesPromise = () => {
      const nodesCacheKey = JSON.stringify({
        // typeName + count being the same is a pretty good
        // indication that the nodes are the same.
        typeName,
        nodesLength: nodes.length,
        ...fieldsToSift,
      })
      if (
        process.env.NODE_ENV === `production` &&
        resolvedNodesCache.has(nodesCacheKey)
      ) {
        return Promise.resolve(resolvedNodesCache.get(nodesCacheKey))
      } else {
        return Promise.all(
          nodes.map(node => {
            const cacheKey = enhancedNodeCacheId({
              node,
              args: fieldsToSift,
            })
            if (cacheKey && enhancedNodeCache.has(cacheKey)) {
              return Promise.resolve(enhancedNodeCache.get(cacheKey))
            } else if (cacheKey && enhancedNodePromiseCache.has(cacheKey)) {
              return enhancedNodePromiseCache.get(cacheKey)
            }

            const enhancedNodeGenerationPromise = new Promise(resolve => {
              resolveRecursive(node, fieldsToSift, type.getFields()).then(
                resolvedNode => {
                  trackInlineObjectsInRootNode(resolvedNode)
                  if (cacheKey) {
                    enhancedNodeCache.set(cacheKey, resolvedNode)
                  }
                  resolve(resolvedNode)
                }
              )
            })
            enhancedNodePromiseCache.set(
              cacheKey,
              enhancedNodeGenerationPromise
            )
            return enhancedNodeGenerationPromise
          })
        ).then(resolvedNodes => {
          resolvedNodesCache.set(nodesCacheKey, resolvedNodes)
          return resolvedNodes
        })
      }
    }
    const tempPromise = nodesPromise().then(myNodes => {
      if (!connection) {
        const index = _.isEmpty(siftArgs)
          ? 0
          : sift.indexOf(
              {
                $and: siftArgs,
              },
              myNodes
            )

        // If a node is found, create a dependency between the resulting node and
        // the path.
        if (index !== -1) {
          createPageDependency({
            path,
            nodeId: myNodes[index].id,
          })

          return myNodes[index]
        } else {
          return null
        }
      }

      let result = _.isEmpty(siftArgs)
        ? myNodes
        : sift(
            {
              $and: siftArgs,
            },
            myNodes
          )

      if (!result || !result.length) return null

      // Sort results.
      if (clonedArgs.sort) {
        // create functions that return the item to compare on
        // uses _.get so nested fields can be retrieved
        const convertedFields = clonedArgs.sort.fields
          .map(field => field.replace(/___/g, `.`))
          .map(field => v => _.get(v, field))

        result = _.orderBy(result, convertedFields, clonedArgs.sort.order)
      }

      const connectionArray = connectionFromArray(result, args)
      connectionArray.totalCount = result.length
      if (result.length > 0 && result[0].internal) {
        createPageDependency({
          path,
          connection: result[0].internal.type,
        })
      }
      return connectionArray
    })

    return tempPromise
  } else {
    try {
      // No Plugin fields. Run loki directly

      const coll = db.getCollection(type.name)
      const preArgs = _.reduce(siftArgs, (acc, e) => _.merge(acc, e), {})
      const lokiArgs = _lokiArgsFlatten(preArgs, ``)

      const findArgs = { $and: lokiArgs }
      let result

      if (connection) {
        // Handle connection (e.g allMarkdownRemark)
        return execConnection(coll, findArgs, clonedArgs, path)
      } else {
        // Handle single (e.g markdownRemark)
        return execSingle(coll, findArgs, path)
      }
    } catch (e) {
      console.log(e)
    }
  }
}
