const { store } = require(`./index`)

/////////////////////////////////////////////////////////////////////
// Query
/////////////////////////////////////////////////////////////////////

/**
 * Get all nodes from redux store.
 *
 * @returns {Array}
 */
const getNodes = () => {
  const nodes = store.getState().nodes
  if (nodes) {
    return Array.from(nodes.values())
  } else {
    return []
  }
}

exports.getNodes = getNodes

const getNode = id => store.getState().nodes.get(id)

/** Get node by id from store.
 *
 * @param {string} id
 * @returns {Object}
 */
exports.getNode = getNode

exports.getNodesByType = type =>
  getNodes().filter(node => node.internal.type === type)

/**
 * Determine if node has changed.
 *
 * @param {string} id
 * @param {string} digest
 * @returns {boolean}
 */
exports.hasNodeChanged = (id, digest) => {
  const node = store.getState().nodes.get(id)
  if (!node) {
    return true
  } else {
    return node.internal.contentDigest !== digest
  }
}

/**
 * Get node and save path dependency.
 *
 * @param {string} id
 * @param {string} path
 * @returns {Object} node
 */
exports.getNodeAndSavePathDependency = (id, path) => {
  const { createPageDependency } = require(`./actions/add-page-dependency`)
  const node = getNode(id)
  createPageDependency({ path, nodeId: id })
  return node
}

/////////////////////////////////////////////////////////////////////
// Reducer
/////////////////////////////////////////////////////////////////////

exports.reducer = (state = new Map(), action) => {
  switch (action.type) {
    case `DELETE_CACHE`:
      return new Map()
    case `CREATE_NODE`: {
      state.set(action.payload.id, action.payload)
      return state
    }

    case `ADD_FIELD_TO_NODE`:
    case `ADD_CHILD_NODE_TO_PARENT_NODE`:
      state.set(action.payload.id, action.payload)
      return state

    case `DELETE_NODE`: {
      state.delete(action.payload.id)
      return state
    }

    case `DELETE_NODES`: {
      action.payload.forEach(id => state.delete(id))
      return state
    }

    default:
      return state
  }
}
